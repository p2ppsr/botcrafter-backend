exports.up = async knex => {
  await knex.schema.table('users', table => {
      table.boolean('nsfw')
  })
}
exports.down = async knex => {
  await knex.schema.table('users', table => {
      table.dropColumn('nsfw')
  })
}
