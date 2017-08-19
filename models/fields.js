'use strict';

const knex = require('../lib/knex');
const hasher = require('node-object-hash')();
const slugify = require('slugify');
const { enforce, filterObject } = require('../lib/helpers');
const dtHelpers = require('../lib/dt-helpers');
const interoperableErrors = require('../shared/interoperable-errors');
const shares = require('./shares');
const bluebird = require('bluebird');
const validators = require('../shared/validators');
const shortid = require('shortid');
const segments = require('./segments');

const allowedKeysCreate = new Set(['name', 'key', 'default_value', 'type', 'group', 'settings']);
const allowedKeysUpdate = new Set(['name', 'key', 'default_value', 'group', 'settings']);
const hashKeys = allowedKeysCreate;

const fieldTypes = {};

fieldTypes.text = fieldTypes.website = {
    validate: entity => {},
    addColumn: (table, name) => table.string(name),
    indexed: true,
    grouped: false
};

fieldTypes.longtext = fieldTypes.gpg = {
    validate: entity => {},
    addColumn: (table, name) => table.text(name),
    indexed: false,
    grouped: false
};

fieldTypes.json = {
    validate: entity => {},
    addColumn: (table, name) => table.json(name),
    indexed: false,
    grouped: false
};

fieldTypes.number = {
    validate: entity => {},
    addColumn: (table, name) => table.integer(name),
    indexed: true,
    grouped: false
};

fieldTypes.checkbox = fieldTypes['radio-grouped'] = fieldTypes['dropdown-grouped'] = {
    validate: entity => {},
    indexed: true,
    grouped: true
};

fieldTypes['radio-enum'] = fieldTypes['dropdown-enum'] = {
    validate: entity => {
        enforce(entity.settings.options, 'Options missing in settings');
        enforce(Object.keys(entity.settings.options).includes(entity.default_value), 'Default value not present in options');
    },
    addColumn: (table, name) => table.string(name),
    indexed: true,
    grouped: false
};

fieldTypes.option = {
    validate: entity => {},
    addColumn: (table, name) => table.boolean(name),
    indexed: true,
    grouped: false
};

fieldTypes['date'] = fieldTypes['birthday'] = {
    validate: entity => {
        enforce(['eur', 'us'].includes(entity.settings.dateFormat), 'Date format incorrect');
    },
    addColumn: (table, name) => table.dateTime(name),
    indexed: true,
    grouped: false
};

const groupedTypes = Object.keys(fieldTypes).filter(key => fieldTypes[key].grouped);

function hash(entity) {
    return hasher.hash(filterObject(entity, hashKeys));
}

async function getById(context, listId, id) {
    return await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'list', listId, 'manageFields');

        const entity = await tx('custom_fields').where({list: listId, id}).first();

        const orderFields = {
            order_list: 'orderListBefore',
            order_subscribe: 'orderSubscribeBefore',
            order_manage: 'orderManageBefore'
        };

        for (const key in orderFields) {
            if (entity[key] !== null) {
                const orderIdRow = await tx('custom_fields').where('list', listId).where(key, '>', entity[key]).orderBy(key, 'asc').select(['id']).first();
                if (orderIdRow) {
                    entity[orderFields[key]] = orderIdRow.id;
                } else {
                    entity[orderFields[key]] = 'end';
                }
            } else {
                entity[orderFields[key]] = 'none';
            }
        }

        return entity;
    });
}

async function listTx(tx, listId) {
    return await tx('custom_fields').where({list: listId}).select(['id', 'name', 'type', 'key', 'column', 'order_list', 'order_subscribe', 'order_manage']).orderBy('id', 'asc');
}

async function list(context, listId) {
    return await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'list', listId, 'manageFields');
        return await listTx(tx, listId);
    });
}

async function listByOrderListTx(tx, listId, extraColumns = []) {
    return await tx('custom_fields').where({list: listId}).whereNotNull('order_list').select(['name', ...extraColumns]).orderBy('order_list', 'asc');
}

async function listDTAjax(context, listId, params) {
    return await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'list', listId, 'manageFields');

        return await dtHelpers.ajaxListTx(
            tx,
            params,
            builder => builder
                .from('custom_fields')

                // This self join is to provide 'option' fields a reference to their parent grouped field. If the field is not an option, it refers to itself
                // All this is to show options always below their group parent
                .innerJoin('custom_fields AS parent_fields', function() {
                    this.on(function() {
                        this.on('custom_fields.type', '=', knex.raw('?', ['option']))
                            .on('custom_fields.group', '=', 'parent_fields.id');
                    }).orOn(function() {
                        this.on('custom_fields.type', '<>', knex.raw('?', ['option']))
                            .on('custom_fields.id', '=', 'parent_fields.id');
                    });
                })
                .where('custom_fields.list', listId),
            [ 'custom_fields.id', 'custom_fields.name', 'custom_fields.type', 'custom_fields.key', 'custom_fields.order_list' ],
            {
                orderByBuilder: (builder, orderColumn, orderDir) => {
                    // We use here parent_fields to keep options always below their parent group
                    if (orderColumn === 'custom_fields.order_list') {
                        builder
                            .orderBy(knex.raw('-parent_fields.order_list'), orderDir === 'asc' ? 'desc' : 'asc') // This is MySQL speciality. It sorts the rows in ascending order with NULL values coming last
                            .orderBy('parent_fields.name', orderDir)
                            .orderBy(knex.raw('custom_fields.type = "option"'), 'asc')
                    } else {
                        const parentColumn = orderColumn.replace(/^custom_fields/, 'parent_fields');
                        builder
                            .orderBy(parentColumn, orderDir)
                            .orderBy('parent_fields.name', orderDir)
                            .orderBy(knex.raw('custom_fields.type = "option"'), 'asc');
                    }
                }
            }
        );
    });
}

async function listGroupedDTAjax(context, listId, params) {
    return await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'list', listId, 'manageFields');

        return await dtHelpers.ajaxListTx(
            tx,
            params,
            builder => builder
                .from('custom_fields')
                .where('custom_fields.list', listId)
                .whereIn('custom_fields.type', groupedTypes),
            ['custom_fields.id', 'custom_fields.name', 'custom_fields.type', 'custom_fields.key', 'custom_fields.order_list'],
            {
                orderByBuilder: (builder, orderColumn, orderDir) => {
                    if (orderColumn === 'custom_fields.order_list') {
                        builder
                            .orderBy(knex.raw('-custom_fields.order_list'), orderDir === 'asc' ? 'desc' : 'asc') // This is MySQL speciality. It sorts the rows in ascending order with NULL values coming last
                            .orderBy('custom_fields.name', orderDir);
                    } else {
                        builder
                            .orderBy(orderColumn, orderDir)
                            .orderBy('custom_fields.name', orderDir);
                    }
                }
            }
        );
    });
}

async function serverValidate(context, listId, data) {
    return await knex.transaction(async tx => {
        const result = {};
        await shares.enforceEntityPermissionTx(tx, context, 'list', listId, 'manageFields');

        if (data.key) {
            const existingKeyQuery = tx('custom_fields').where({
                list: listId,
                key: data.key
            });

            if (data.id) {
                existingKeyQuery.whereNot('id', data.id);
            }

            const existingKey = await existingKeyQuery.first();
            result.key = {
                exists: !!existingKey
            };
        }

        return result;
    });
}

async function _validateAndPreprocess(tx, listId, entity, isCreate) {
    enforce(entity.type === 'option' || !entity.group, 'Only option may have a group assigned');
    enforce(entity.type !== 'option' || entity.group, 'Option must have a group assigned.');
    enforce(entity.type !== 'option' || (entity.orderListBefore === 'none' && entity.orderSubscribeBefore === 'none' && entity.orderManageBefore === 'none'), 'Option cannot be made visible');

    enforce(!entity.group || await tx('custom_fields').where({list: listId, id: entity.group}).first(), 'Group field does not exist');
    enforce(entity.name, 'Name must be present');

    const fieldType = fieldTypes[entity.type];
    enforce(fieldType, 'Unknown field type');

    const validateErrs = fieldType.validate(entity);

    enforce(validators.mergeTagValid(entity.key), 'Merge tag is not valid.');

    const existingWithKeyQuery = knex('custom_fields').where({
        list: listId,
        key: entity.key
    });
    if (!isCreate) {
        existingWithKeyQuery.whereNot('id', entity.id);
    }
    const existingWithKey = await existingWithKeyQuery.first();
    if (existingWithKey) {
        throw new interoperableErrors.DuplicitKeyError();
    }

    entity.settings = JSON.stringify(entity.settings);
}

async function _sortIn(tx, listId, entityId, orderListBefore, orderSubscribeBefore, orderManageBefore) {
    const flds = await tx('custom_fields').where('list', listId).whereNot('id', entityId);

    const order = {};
    for (const row of flds) {
        order[row.id] = {
            order_list: null,
            order_subscribe: null,
            order_manage: null
        };
    }

    order[entityId] = {
        order_list: null,
        order_subscribe: null,
        order_manage: null
    };

    function computeOrder(fldName, sortInBefore) {
        flds.sort((x, y) => x[fldName] - y[fldName]);
        const ids = flds.filter(x => x[fldName] !== null).map(x => x.id);

        let sortedIn = false;
        let idx = 1;
        for (const id of ids) {
            if (sortInBefore === id) {
                order[entityId][fldName] = idx;
                sortedIn = true;
                idx += 1;
            }

            order[id][fldName] = idx;
            idx += 1;
        }

        if (!sortedIn && sortInBefore !== 'none') {
            order[entityId][fldName] = idx;
        }
    }

    computeOrder('order_list', orderListBefore);
    computeOrder('order_subscribe', orderSubscribeBefore);
    computeOrder('order_manage', orderManageBefore);

    for (const id in order) {
        await tx('custom_fields').where({list: listId, id}).update(order[id]);
    }
}

async function create(context, listId, entity) {
    return await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'list', listId, 'manageFields');

        await _validateAndPreprocess(tx, listId, entity, true);

        const fieldType = fieldTypes[entity.type];

        let columnName;
        if (!fieldType.grouped) {
            columnName = ('custom_' + slugify(entity.name, '_') + '_' + shortid.generate()).toLowerCase().replace(/[^a-z0-9_]/g, '');
        }

        const filteredEntity = filterObject(entity, allowedKeysCreate);
        filteredEntity.list = listId;
        filteredEntity.column = columnName;

        const ids = await tx('custom_fields').insert(filteredEntity);
        const id = ids[0];

        await _sortIn(tx, listId, id, entity.orderListBefore, entity.orderSubscribeBefore, entity.orderManageBefore);

        if (columnName) {
            await knex.schema.table('subscription__' + listId, table => {
                fieldType.addColumn(table, columnName);
                if (fieldType.indexed) {
                    table.index(columnName);
                }
            });
        }

        return id;
    });
}

async function updateWithConsistencyCheck(context, listId, entity) {
    await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'list', listId, 'manageFields');

        const existing = await tx('custom_fields').where({list: listId, id: entity.id}).first();
        if (!existing) {
            throw new interoperableErrors.NotFoundError();
        }

        const existingHash = hash(existing);
        if (existingHash !== entity.originalHash) {
            throw new interoperableErrors.ChangedError();
        }

        enforce(entity.type === existing.type, 'Field type cannot be changed');
        await _validateAndPreprocess(tx, listId, entity, false);

        await tx('custom_fields').where('id', entity.id).update(filterObject(entity, allowedKeysUpdate));
        await _sortIn(tx, listId, entity.id, entity.orderListBefore, entity.orderSubscribeBefore, entity.orderManageBefore);
    });
}

async function removeTx(tx, context, listId, id) {
    await shares.enforceEntityPermissionTx(tx, context, 'list', listId, 'manageFields');

    const existing = await tx('custom_fields').where({list: listId, id: id}).first();
    if (!existing) {
        throw new interoperableErrors.NotFoundError();
    }

    const fieldType = fieldTypes[existing.type];

    await tx('custom_fields').where({list: listId, id}).del();

    if (fieldType.grouped) {
        await tx('custom_fields').where({list: listId, group: id}).del();

    } else {
        await knex.schema.table('subscription__' + listId, table => {
            table.dropColumn(existing.column);
        });

        await segments.removeRulesByColumnTx(tx, context, listId, existing.column);
    }
}

async function remove(context, listId, id) {
    await knex.transaction(async tx => {
        await removeTx(tx, context, listId, id);
    });
}

async function removeAllByListIdTx(tx, context, listId) {
    const entities = await tx('custom_fields').where('list', listId).select(['id']);
    for (const entity of entities) {
        await removeTx(tx, context, listId, entity.id);
    }
}

// This is to handle circular dependency with segments.js
Object.assign(module.exports, {
    hash,
    getById,
    list,
    listTx,
    listByOrderListTx,
    listDTAjax,
    listGroupedDTAjax,
    create,
    updateWithConsistencyCheck,
    remove,
    removeAllByListIdTx,
    serverValidate
});