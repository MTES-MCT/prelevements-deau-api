import test from 'ava'
import {classifyReceiptSmtpError, getDeclarationReceiptMailConfig} from '../declaration-receipt-smtp.js'

const common = {
  SMTP_HOST: 'relay.example.test', SMTP_PORT: '587', SMTP_FROM: 'sender@example.test',
  SMTP_USER: 'mail-service', SMTP_PASSWORD: 'example-password', MAIL_SUBJECT_PREFIX: '[TEST] ',
  FRONT_URL: 'https://front.example.test'
}

test('le SMTP partagé seul ne démarre pas les mails récapitulatifs', t => {
  t.is(getDeclarationReceiptMailConfig(common), null)
})

test('les identifiants partagés restent réservés au relais explicitement sélectionné', t => {
  const shared = getDeclarationReceiptMailConfig({...common, DECLARATION_RECEIPT_SMTP_HOST: 'RELAY.example.test'})
  t.is(shared.smtp.user, common.SMTP_USER)
  t.is(shared.smtp.password, common.SMTP_PASSWORD)
  t.is(shared.subjectPrefix, '[TEST] ')
  const capture = getDeclarationReceiptMailConfig({...common, DECLARATION_RECEIPT_SMTP_HOST: 'mailpit', DECLARATION_RECEIPT_SMTP_PORT: '1025'})
  t.falsy(capture.smtp.user)
  t.falsy(capture.smtp.password)
  t.is(capture.smtp.port, 1025)
})

test('les identifiants dédiés sont employés ensemble et un seul préfixe est retenu', t => {
  const dedicated = {...common, DECLARATION_RECEIPT_SMTP_HOST: 'other.example.test',
    DECLARATION_RECEIPT_SMTP_USER: 'dedicated', DECLARATION_RECEIPT_SMTP_PASSWORD: 'dedicated-secret',
    DECLARATION_RECEIPT_SUBJECT_PREFIX: '[TESTING] '}
  const config = getDeclarationReceiptMailConfig(dedicated)
  t.is(config.subjectPrefix, '[TESTING] ')
  t.is(config.smtp.user, dedicated.DECLARATION_RECEIPT_SMTP_USER)
  t.is(config.smtp.password, dedicated.DECLARATION_RECEIPT_SMTP_PASSWORD)
  for (const invalid of [{DECLARATION_RECEIPT_SMTP_PASSWORD: ''}, {SMTP_PORT: '0'}, {FRONT_URL: 'file:///tmp'}]) {
    t.throws(() => getDeclarationReceiptMailConfig({...dedicated, ...invalid}), {message: /Configuration/})
  }
})

test('la classification SMTP distingue refus certain et absence de confirmation', t => {
  t.is(classifyReceiptSmtpError({responseCode: 450}), 'SMTP_RETRY')
  t.is(classifyReceiptSmtpError({errno: 'ECONNREFUSED'}), 'SMTP_RETRY')
  t.is(classifyReceiptSmtpError({code: 'ESOCKET', originalCode: 'ECONNREFUSED'}), 'SMTP_RETRY')
  t.is(classifyReceiptSmtpError({code: 'ETIMEDOUT', timeoutType: 'CONNECT_TIMEOUT'}), 'SMTP_RETRY')
  t.is(classifyReceiptSmtpError({responseCode: 550}), 'SMTP_REJECTED')
  t.is(classifyReceiptSmtpError({code: 'ETIMEDOUT', command: 'DATA'}), 'SMTP_UNKNOWN')
})
