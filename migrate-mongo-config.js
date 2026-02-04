const config = {
  mongodb: {
    url: process.env.MONGODB_URL || 'mongodb://localhost',
    databaseName: process.env.MONGODB_DBNAME || 'prelevements-deau',
    options: {}
  },
  migrationsDir: 'migrations',
  changelogCollectionName: 'changelog',
  lockCollectionName: 'changelog_lock',
  lockTtl: 0,
  migrationFileExtension: '.js',
  useFileHash: false,
  moduleSystem: 'esm'
}

export default config
