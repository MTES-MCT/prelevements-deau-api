import test from 'ava'
import {ESLint} from 'eslint'

const eslint = new ESLint()

test('la qualité détecte les variables inconnues et les affectations sans effet', async t => {
  const [result] = await eslint.lintText('let value = 1\nvalue = 2\nconsole.log(value, missingVariable)\n', {filePath: 'lib/lint-fixture.js'})
  t.true(result.messages.some(message => message.ruleId === 'no-undef'))
  t.true(result.messages.some(message => message.ruleId === 'no-useless-assignment'))
})

test('la qualité détecte les expressions régulières à complexité dangereuse', async t => {
  const [result] = await eslint.lintText('export const expression = /^(a+)+$/\n', {filePath: 'lib/lint-fixture.js'})
  t.true(result.messages.some(message => message.ruleId === 'regexp/no-super-linear-backtracking'))
})

test('la qualité refuse les tests exclusifs sans imposer un style d’assertion', async t => {
  const [result] = await eslint.lintText("import test from 'ava'\ntest.only('fixture', t => { t.is(true, true) })\n", {filePath: 'lib/util/__tests__/lint-fixture.js'})
  t.true(result.messages.some(message => message.ruleId === 'ava/no-only-test'))
  t.false(result.messages.some(message => message.ruleId === 'ava/use-true-false'))
})
