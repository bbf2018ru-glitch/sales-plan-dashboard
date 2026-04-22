const { JsonStore } = require('./json-store');
const { PostgresStore } = require('./postgres-store');

function createStore(options) {
  if (options.databaseUrl) {
    return new PostgresStore({
      connectionString: options.databaseUrl
    });
  }

  return new JsonStore({
    dbPath: options.dbPath,
    sampleDbPath: options.sampleDbPath
  });
}

module.exports = {
  createStore
};
