import test from 'ava'
import {normalizeEmail} from '../email.js'

test('normalizeEmail / met l\'email en minuscules', t => {
  const normalized = normalizeEmail('Alice.DUPONT@EXAMPLE.COM')
  t.is(normalized, 'alice.dupont@example.com')
})

test('normalizeEmail / supprime les espaces', t => {
  const normalized = normalizeEmail('  bob@example.com  ')
  t.is(normalized, 'bob@example.com')
})

test('normalizeEmail / accepte le caractère +', t => {
  const normalized = normalizeEmail('user+tag@example.com')
  t.is(normalized, 'user+tag@example.com')
})

test('normalizeEmail / accepte les points dans le nom', t => {
  const normalized = normalizeEmail('first.last@example.com')
  t.is(normalized, 'first.last@example.com')
})

test('normalizeEmail / accepte les tirets', t => {
  const normalized = normalizeEmail('user-name@example.com')
  t.is(normalized, 'user-name@example.com')
})

test('normalizeEmail / accepte les underscores', t => {
  const normalized = normalizeEmail('user_name@example.com')
  t.is(normalized, 'user_name@example.com')
})

test('normalizeEmail / rejette un email sans @', t => {
  t.throws(() => normalizeEmail('invalidemail'), {message: /Format d'email invalide/})
})

test('normalizeEmail / rejette un email vide', t => {
  t.throws(() => normalizeEmail(''), {message: /Email invalide/})
})

test('normalizeEmail / rejette null', t => {
  t.throws(() => normalizeEmail(null), {message: /Email invalide/})
})

test('normalizeEmail / rejette undefined', t => {
  t.throws(() => normalizeEmail(undefined), {message: /Email invalide/})
})

test('normalizeEmail / rejette un non-string', t => {
  t.throws(() => normalizeEmail(123), {message: /Email invalide/})
})

test('normalizeEmail / rejette un email sans domaine', t => {
  t.throws(() => normalizeEmail('user@'), {message: /Format d'email invalide/})
})

test('normalizeEmail / rejette un email sans nom d\'utilisateur', t => {
  t.throws(() => normalizeEmail('@example.com'), {message: /Format d'email invalide/})
})

test('normalizeEmail / rejette un domaine invalide', t => {
  t.throws(() => normalizeEmail('user@domain'), {message: /Format d'email invalide/})
})

test('normalizeEmail / accepte un domaine avec sous-domaines', t => {
  const normalized = normalizeEmail('user@mail.example.com')
  t.is(normalized, 'user@mail.example.com')
})

test('normalizeEmail / accepte un TLD long', t => {
  const normalized = normalizeEmail('user@example.museum')
  t.is(normalized, 'user@example.museum')
})

test('normalizeEmail / accepte des chiffres dans le domaine', t => {
  const normalized = normalizeEmail('user@example123.com')
  t.is(normalized, 'user@example123.com')
})

test('normalizeEmail / gère les caractères accentués (devrait rejeter)', t => {
  t.throws(() => normalizeEmail('utilisateur@exämple.com'), {message: /Format d'email invalide/})
})
