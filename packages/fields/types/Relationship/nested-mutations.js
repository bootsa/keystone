const groupBy = require('lodash.groupby');
const pSettle = require('p-settle');
const { intersection, pick } = require('@voussoir/utils');
const { ParameterError } = require('./graphqlErrors');

const NESTED_MUTATIONS = ['create', 'connect', 'disconnect', 'disconnectAll'];

/*** Input validation  ***/
const throwWithErrors = ({ message, errors }) => {
  const error = new Error(message);
  error.errors = errors;
  throw error;
};

function validateInput({ input, target, many }) {
  // Only accept mutations which we know how to handle.
  let validInputMutations = intersection(Object.keys(input), NESTED_MUTATIONS);

  // Filter out mutations which don't have any parameters
  if (many) {
    // to-many must have an array of at least one item with at least one key
    validInputMutations = validInputMutations.filter(
      mutation =>
        mutation === 'disconnectAll' ||
        (Array.isArray(input[mutation]) &&
          input[mutation].filter(item => Object.keys(item).length).length)
    );
  } else {
    validInputMutations = validInputMutations.filter(
      mutation => mutation === 'disconnectAll' || Object.keys(input[mutation]).length
    );
  }

  // We must have at least one valid mutation
  if (!validInputMutations.length) {
    throw new ParameterError({
      message: `Must provide a nested mutation (${NESTED_MUTATIONS.join(
        ', '
      )}) when mutating ${target}`,
    });
  }

  // For a non-many relationship we can't create AND connect - only one can be set at a time
  if (!many && validInputMutations.includes('create') && validInputMutations.includes('connect')) {
    throw new ParameterError({
      message: `Can only provide one of 'connect' or 'create' when mutating ${target}`,
    });
  }
  return validInputMutations;
}

const cleanAndValidateInput = ({ input, many, localField, target }) => {
  try {
    return pick(input, validateInput({ input, target, many }));
  } catch (error) {
    const message = `Nested mutation operation invalid for ${target}`;
    throwWithErrors({ message, errors: [{ ...error, path: [localField.path] }] });
  }
};

const _runActions = async (action, targets, path) => {
  const results = await pSettle((targets || []).map(action));
  const errors = results
    .map((settleInfo, index) => ({ ...settleInfo, index }))
    .filter(({ isRejected }) => isRejected)
    .map(({ reason, index }) => ({ ...reason, path: [...path, index] }));
  // If there are no errors we know everything resolved successfully
  return [errors.length ? [] : results.map(({ value }) => value), errors];
};

async function resolveNestedMany({
  input,
  currentValue,
  refList,
  context,
  localField,
  target,
  mutationState,
}) {
  // Disconnections
  let disconnectIds = [];
  if (input.disconnectAll) {
    disconnectIds = [...currentValue];
  } else if (input.disconnect) {
    // We want to avoid DB lookups where possible, so we split the input into
    // two halves; one with ids, and the other without ids
    const { withId, withoutId } = groupBy(input.disconnect, ({ id }) =>
      id ? 'withId' : 'withoutId'
    );

    // We set the Ids we do find immediately
    disconnectIds = (withId || []).map(({ id }) => id);

    // And any without ids (ie; other unique criteria), have to be looked up
    // This will resolve access control, etc for us.
    // In the future, when WhereUniqueInput accepts more than just an id,
    // this will also resolve those queries for us too.
    const action = where => refList.itemQuery(where, context, refList.gqlNames.itemQueryName);
    // We don't throw if any fail; we're only interested in the ones this user has
    // access to read (and hence remove from the list)
    const disconnectItems = (await pSettle((withoutId || []).map(action)))
      .filter(({ isFulfilled }) => isFulfilled)
      .map(({ value }) => value)
      .filter(itemToDisconnect => itemToDisconnect); // Possible to get null results when the id doesn't exist, or read access is denied

    disconnectIds.push(...disconnectItems.map(({ id }) => id));
  }

  // Connections
  let allConnectedIds = [];
  if (input.connect || input.create) {
    // This will resolve access control, etc for us.
    // In the future, when WhereUniqueInput accepts more than just an id,
    // this will also resolve those queries for us too.
    const [connectedItems, connectErrors] = await _runActions(
      where => refList.itemQuery(where.id, context, refList.gqlNames.itemQueryName),
      input.connect,
      [localField.path, 'connect']
    );

    // Create related item. Will check for access control itself, no need to do anything extra here.
    // NOTE: We don't check for read access control on the returned ids as the
    // user will not have seen it, so it's ok to return it directly here.
    const [createdItems, createErrors] = await _runActions(
      data => refList.createMutation(data, context, mutationState),
      input.create,
      [localField.path, 'create']
    );

    // Combine and map the data in the format we actually need
    // Created items now get connected too, so they're coming along for the ride!
    allConnectedIds = [...connectedItems, ...createdItems]
      // Possible to get null results when the id doesn't exist, or read access is denied
      .filter(itemConnected => itemConnected)
      .map(({ id }) => id);

    const allErrors = [...connectErrors, ...createErrors];
    if (allErrors.length) {
      const message = `Unable to create and/or connect ${allErrors.length} ${target}`;
      throwWithErrors({ message, errors: allErrors });
    }
  }

  return { disconnect: disconnectIds, connect: allConnectedIds };
}

async function resolveNestedSingle({
  input,
  currentValue,
  localField,
  refList,
  context,
  target,
  mutationState,
}) {
  let result_ = {};
  if ((input.disconnect || input.disconnectAll) && currentValue) {
    let idToDisconnect;
    if (input.disconnectAll) {
      idToDisconnect = currentValue;
    } else if (input.disconnect.id) {
      idToDisconnect = input.disconnect.id;
    } else {
      try {
        // Support other unique fields for disconnection
        idToDisconnect = (await refList.itemQuery(
          input.disconnect,
          context,
          refList.gqlNames.itemQueryName
        )).id.toString();
      } catch (error) {
        // Maybe we don't have read access, or maybe the item doesn't exist
        // (recently deleted, or it's an erroneous value in the relationship field)
        // So we silently ignore it
      }
    }

    if (currentValue === idToDisconnect) {
      // Found the item, so unset it
      result_.disconnect = [idToDisconnect];
    }
  }

  if (input.connect || input.create) {
    // override result with the connected/created value
    // input is of type *RelateToOneInput
    let item;
    try {
      item = await (input.connect
        ? refList.itemQuery(input.connect.id, context, refList.gqlNames.itemQueryName)
        : refList.createMutation(input.create, context, mutationState));
    } catch (error) {
      const operation = input.connect ? 'connect' : 'create';
      const message = `Unable to ${operation} a ${target}`;
      throwWithErrors({ message, errors: [{ ...error, path: [localField.path, operation] }] });
    }

    // Might not exist if the input id doesn't exist / the user doesn't have read access
    if (item) {
      result_.connect = [item.id];
    }
  }
  return result_;
}

/*
 * Resolve the nested mutations and return the ids of items to be connected/disconnected
 *
 * Returns: { connect: [id], disconnect: [id]}
 */
async function resolveNested({ input, currentValue, many, listInfo, context, mutationState }) {
  const localList = listInfo.local.list;
  const localField = listInfo.local.field;
  const refList = listInfo.foreign.list;
  const target = `${localList.key}.${localField.path}<${refList.key}>`;
  const args = {
    currentValue,
    refList,
    input: cleanAndValidateInput({ input, many, localField, target }),
    context,
    localField,
    target,
    mutationState,
  };
  return await (many ? resolveNestedMany(args) : resolveNestedSingle(args));
}

module.exports = {
  resolveNested,
};
