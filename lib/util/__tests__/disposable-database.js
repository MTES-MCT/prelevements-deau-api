import test from 'ava'
import {requireDisposableDatabase} from '../test-helpers/disposable-database.js'

test('accepte uniquement les bases jetables connues en local ou CI', t => {
  for (const name of ['campaign_tests', 'security_tests']) {
    t.is(requireDisposableDatabase(`postgres://test:password@127.0.0.1:55439/${name}`, {NODE_ENV: 'test'}).pathname, `/${name}`)
    t.is(requireDisposableDatabase(`postgresql://test:password@postgres:5432/${name}`, {NODE_ENV: 'test', CI: 'true'}).hostname, 'postgres')
  }
})

test('refuse une cible réelle même avec le mode CI ou un paramètre de redirection', t => {
  for (const value of [
    'postgres://test:password@prod.example.test:55439/security_tests',
    'postgres://test:password@127.0.0.1:5432/security_tests',
    'postgres://test:password@127.0.0.1:55439/production',
    'postgres://test:password@127.0.0.1:55439/security_tests?host=prod.example.test',
    'postgres://test:password@127.0.0.1:55439/security_tests?hostaddr=192.0.2.1',
    'postgres://test:password@127.0.0.1:55439/security_tests?port=5432',
    'postgres://test:password@127.0.0.1:55439/security_tests?options=-c%20search_path=production',
    'postgres://test:password@127.0.0.1:55439/security_tests#fragment',
    'postgres://test:password@127.0.0.1:55439/%FF',
    'https://127.0.0.1:55439/security_tests',
    'invalide'
  ]) {
    const error = t.throws(() => requireDisposableDatabase(value, {NODE_ENV: 'test', CI: 'true'}))
    t.false(error.message.includes('password'))
  }
})

test('refuse un serveur postgres hors CI et tout mode non test', t => {
  t.throws(() => requireDisposableDatabase('postgres://postgres:5432/security_tests', {NODE_ENV: 'test'}))
  t.throws(() => requireDisposableDatabase('postgres://127.0.0.1:55439/security_tests', {NODE_ENV: 'production'}))
})
