import test from 'ava'
import {validateRegleCreation, validateRegleChanges} from '../regle-validation.js'
import {ValidationError} from '../../util/payload.js'

function regleValideBase() {
  return {
    parametre: 'Volume journalier',
    unite: 'm³',
    valeur: 10,
    contrainte: 'minimum',
    debut_validite: '2024-01-01',
    fin_validite: null,
    debut_periode: null,
    fin_periode: null,
    remarque: null,
    document: null,
    exploitations: ['1234567890abcdef12345678']
  }
}

// ---------------- Regle creation schema tests ----------------

test('regleSchemaCreation / valide', t => {
  const input = regleValideBase()
  const value = validateRegleCreation(input)
  t.deepEqual(value, input)
})

test('regleSchemaCreation / avec document', t => {
  const input = regleValideBase()
  input.document = 'abcdef1234567890abcdef12'
  const value = validateRegleCreation(input)
  t.deepEqual(value, input)
})

test('regleSchemaCreation / parametre invalide', t => {
  const input = {...regleValideBase(), parametre: 'Bidon'}
  const error = t.throws(() => validateRegleCreation(input), {instanceOf: ValidationError})
  t.true(error.details.some(d => d.message === 'Le paramètre est invalide.'))
})

test('regleSchemaCreation / unite invalide', t => {
  const input = {...regleValideBase(), unite: 'Bidon'}
  const error = t.throws(() => validateRegleCreation(input), {instanceOf: ValidationError})
  t.true(error.details.some(d => d.message === 'L\'unité est invalide.'))
})

test('regleSchemaCreation / valeur manquante', t => {
  const input = regleValideBase()
  delete input.valeur
  const error = t.throws(() => validateRegleCreation(input), {instanceOf: ValidationError})
  t.true(error.details.some(d => d.message === 'La valeur est obligatoire.'))
})

test('regleSchemaCreation / valeur non numerique', t => {
  const input = {...regleValideBase(), valeur: 'abc'}
  const error = t.throws(() => validateRegleCreation(input), {instanceOf: ValidationError})
  t.true(error.details.some(d => d.message === 'La valeur doit être un nombre.'))
})

test('regleSchemaCreation / contrainte invalide', t => {
  const input = {...regleValideBase(), contrainte: 'toto'}
  const error = t.throws(() => validateRegleCreation(input), {instanceOf: ValidationError})
  t.true(error.details.some(d => d.message === 'La contrainte est invalide.'))
})

test('regleSchemaCreation / debut_validite manquante', t => {
  const input = regleValideBase()
  delete input.debut_validite
  const error = t.throws(() => validateRegleCreation(input), {instanceOf: ValidationError})
  t.true(error.details.some(d => d.message === 'La date de début de validité est obligatoire.'))
})

test('regleSchemaCreation / exploitations vide', t => {
  const input = {...regleValideBase(), exploitations: []}
  const error = t.throws(() => validateRegleCreation(input), {instanceOf: ValidationError})
  t.true(error.details.some(d => d.message === 'Au moins une exploitation est obligatoire.'))
})

test('regleSchemaCreation / exploitations ObjectId invalide', t => {
  const input = {...regleValideBase(), exploitations: ['invalid']}
  const error = t.throws(() => validateRegleCreation(input), {instanceOf: ValidationError})
  t.true(error.details.length > 0)
})

test('regleSchemaCreation / document ObjectId invalide', t => {
  const input = {...regleValideBase(), document: 'invalid'}
  const error = t.throws(() => validateRegleCreation(input), {instanceOf: ValidationError})
  t.true(error.details.length > 0)
})

test('regleSchemaCreation / remarque trop courte', t => {
  const input = {...regleValideBase(), remarque: 'ab'}
  const error = t.throws(() => validateRegleCreation(input), {instanceOf: ValidationError})
  t.true(error.details.some(d => d.message.includes('remarque') && d.message.includes('au moins')))
})

test('regleSchemaCreation / dates invalides', t => {
  const input = regleValideBase()
  input.debut_validite = '2024-13-01'
  const error = t.throws(() => validateRegleCreation(input), {instanceOf: ValidationError})
  t.true(error.details.some(d => d.message === 'La date est invalide.'))
})

test('regleSchemaCreation / remarque trop longue', t => {
  const input = {...regleValideBase(), remarque: 'a'.repeat(600)}
  const error = t.throws(() => validateRegleCreation(input), {instanceOf: ValidationError})
  t.true(error.details.some(d => d.message.includes('remarque') && d.message.includes('plus de')))
})

// ---------------- Regle edition schema tests ----------------

test('regleSchemaEdition / valide partiel', t => {
  const changes = {
    valeur: 20,
    remarque: 'Mise à jour'
  }
  const value = validateRegleChanges(changes)
  t.deepEqual(value, changes)
})

test('regleSchemaEdition / parametre invalide', t => {
  const changes = {parametre: 'Bidon'}
  const error = t.throws(() => validateRegleChanges(changes), {instanceOf: ValidationError})
  t.true(error.details.some(d => d.message === 'Le paramètre est invalide.'))
})

test('regleSchemaEdition / unite invalide', t => {
  const changes = {unite: 'Bidon'}
  const error = t.throws(() => validateRegleChanges(changes), {instanceOf: ValidationError})
  t.true(error.details.some(d => d.message === 'L\'unité est invalide.'))
})

test('regleSchemaEdition / valeur non numerique', t => {
  const changes = {valeur: 'abc'}
  const error = t.throws(() => validateRegleChanges(changes), {instanceOf: ValidationError})
  t.true(error.details.some(d => d.message === 'La valeur doit être un nombre.'))
})

test('regleSchemaEdition / exploitations peut être mis à jour', t => {
  const changes = {exploitations: ['1234567890abcdef12345678', 'abcdef1234567890abcdef12']}
  const value = validateRegleChanges(changes)
  t.deepEqual(value.exploitations, ['1234567890abcdef12345678', 'abcdef1234567890abcdef12'])
})

test('regleSchemaEdition / document peut être mis à jour', t => {
  const changes = {document: '1234567890abcdef12345678'}
  const value = validateRegleChanges(changes)
  t.is(value.document, '1234567890abcdef12345678')
})

test('regleSchemaEdition / document peut être null', t => {
  const changes = {document: null}
  const value = validateRegleChanges(changes)
  t.is(value.document, null)
})

test('regleSchemaEdition / multiple erreurs', t => {
  const changes = {
    parametre: 'Bidon',
    unite: 'Bidon',
    valeur: 'abc'
  }
  const error = t.throws(() => validateRegleChanges(changes), {instanceOf: ValidationError})
  const msgs = new Set(error.details.map(d => d.message))
  t.true(msgs.has('Le paramètre est invalide.'))
  t.true(msgs.has('L\'unité est invalide.'))
  t.true(msgs.has('La valeur doit être un nombre.'))
})
