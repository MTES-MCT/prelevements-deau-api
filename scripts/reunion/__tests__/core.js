import test from 'ava'

import {
  EXCLUDED_DOCUMENT_ID,
  TRANSFORMER_VERSION,
  assertSafeTarget,
  assertTransformationContract,
  buildDeclarantContactPlan,
  buildPreflight,
  buildTargetAttestation,
  buildTransformationContract,
  chooseDeclarantLoginEmail,
  deterministicStorageKey,
  groupManifestRecords,
  legacyNestedString,
  manifestLines,
  normalizeUsageCodes,
  parseArguments,
  parseUsageMap,
  partitionDocuments,
  partitionRules,
  readManifestContent,
  sha256,
  stableSourceId,
  toDateOnly
} from '../lib/core.js'

test('toDateOnly normalise un horodatage Mongo pour une colonne PostgreSQL date', t => {
  t.is(
    toDateOnly('2026-08-27T14:25:36.123Z').toISOString(),
    '2026-08-27T00:00:00.000Z'
  )
  t.is(toDateOnly(null), null)
})

test('parseArguments garde le mode écriture désactivé par défaut', t => {
  const options = parseArguments([
    'apply',
    '--manifest',
    '/tmp/source.jsonl',
    '--target=local',
    '--target-env',
    '.env'
  ])

  t.is(options.command, 'apply')
  t.false(options.apply)
  t.is(options.target, 'local')
})

test('assertSafeTarget exige une confirmation identique et refuse production', t => {
  const localEnvironment = {
    APP_ENV: 'reunion-local',
    DATABASE_URL: 'postgresql://pe_reunion:secret@127.0.0.1:5433/pe_reunion',
    S3_ENDPOINT: 'http://127.0.0.1:9002',
    S3_REGION: 'fr-par',
    S3_BUCKET_PREFIX: 'reunion-migration-'
  }
  const testingEnvironment = {
    APP_ENV: 'testing',
    DATABASE_URL: 'postgresql://testing-partageons-leau-api:secret@rw-a94bb20e-1f62-4203-9b60-234c12170876.rdb.fr-par.scw.cloud:5826/testing-partageons-leau-api?sslmode=verify-full&sslrootcert=%2Ftmp%2Ftesting-ca.pem',
    S3_ENDPOINT: 'https://s3.fr-par.scw.cloud',
    S3_REGION: 'fr-par',
    S3_BUCKET_PREFIX: 'testing-'
  }
  const manifestSha256 = 'a'.repeat(64)
  const testingAttestation = buildTargetAttestation({
    target: 'testing',
    targetEnvironment: testingEnvironment,
    manifestSha256
  })

  t.throws(() => assertSafeTarget({
    target: 'testing',
    confirmTarget: 'local',
    apply: true,
    targetEnv: '.env.testing',
    targetEnvironment: testingEnvironment,
    manifestSha256
  }), {message: new RegExp(`--confirm-target ${testingAttestation.confirmation}`)})

  t.throws(() => assertSafeTarget({
    target: 'testing',
    confirmTarget: 'testing',
    apply: true,
    targetEnv: '.env.production',
    targetEnvironment: testingEnvironment,
    manifestSha256
  }), {message: /production/i})

  t.notThrows(() => assertSafeTarget({
    target: 'local',
    confirmTarget: 'local',
    apply: true,
    targetEnv: '.env.reunion-local',
    targetEnvironment: localEnvironment,
    manifestSha256
  }))

  t.notThrows(() => assertSafeTarget({
    target: 'testing',
    confirmTarget: testingAttestation.confirmation,
    apply: true,
    targetEnv: '.env.testing',
    targetEnvironment: testingEnvironment,
    manifestSha256
  }))

  t.throws(() => assertSafeTarget({
    target: 'local',
    confirmTarget: 'local',
    apply: true,
    targetEnv: '.env.local',
    targetEnvironment: {
      ...localEnvironment,
      DATABASE_URL: 'postgresql://pe_reunion:secret@database.example.test:5433/pe_reunion'
    },
    manifestSha256
  }), {message: /identité PostgreSQL non autorisée/})

  t.throws(() => assertSafeTarget({
    target: 'testing',
    apply: false,
    targetEnv: '.env.testing',
    targetEnvironment: {...testingEnvironment, S3_BUCKET_PREFIX: 'prod-'},
    manifestSha256
  }), {message: /Cible production détectée|identité S3 non autorisée/})

  t.throws(() => assertSafeTarget({
    target: 'local',
    apply: false,
    targetEnv: '.env.local',
    targetEnvironment: {
      ...localEnvironment,
      DATABASE_URL: `${localEnvironment.DATABASE_URL}?host=database.example.test`
    },
    manifestSha256
  }), {message: /paramètre DATABASE_URL interdit/})

  t.throws(() => assertSafeTarget({
    target: 'testing',
    apply: false,
    targetEnv: '.env.testing',
    targetEnvironment: {
      ...testingEnvironment,
      DATABASE_URL: `${testingEnvironment.DATABASE_URL}&sslrootcert=%2Ftmp%2Fother-ca.pem`
    },
    manifestSha256
  }), {message: /absent ou dupliqué/})
})

test('usage-map conserve le premier usage racine et déduplique les secondaires', t => {
  const map = parseUsageMap(`legacy_exploitation_id,source_usage_codes,primary_usage_code,secondary_usage_codes,provenance
12,"2A,5A,4A,4B",2,"5|4|4",ods
`)

  t.deepEqual(normalizeUsageCodes('2A,5A,4A,4B'), ['2', '5', '4'])
  t.deepEqual(map.get('12'), {
    legacyId: '12',
    sourceUsageCodes: '2A,5A,4A,4B',
    primary: '2',
    secondary: ['5', '4'],
    provenance: 'ods'
  })
})

test('sourceId et clés S3 sont déterministes et ne contiennent pas de chemin parent', t => {
  t.is(
    stableSourceId('document', 'abc', 42),
    'reunion:DEP-974:document:abc:owner:42'
  )
  t.is(
    deterministicStorageKey({
      ownerLegacyId: 42,
      documentLegacyId: 'abc',
      filename: '../../arrêté.pdf'
    }),
    'reunion/DEP-974/42/abc/arrêté.pdf'
  )
})

test('champs structurés des points deviennent des scalaires Prisma', t => {
  t.is(legacyNestedString({nom: 'Saint-Paul', code: '97415'}, 'nom'), 'Saint-Paul')
  t.is(legacyNestedString({nom: 'Saint-Paul', code: '97415'}, 'code'), '97415')
  t.is(legacyNestedString({id_bss: '12288X0074/F'}, 'id_bss'), '12288X0074/F')
  t.is(legacyNestedString({point: 1234}, 'point'), '1234')
  t.is(legacyNestedString('valeur legacy', 'code'), 'valeur legacy')
  t.is(legacyNestedString(null, 'code'), null)
  t.is(legacyNestedString({code: null}, 'code'), null)
  t.is(legacyNestedString({code: {nested: true}}, 'code'), null)
})

test('manifest JSONL est canonique, relisible et contrôlable par sha256', t => {
  const transformationContract = buildTransformationContract({
    usageMap: Buffer.from('usage'),
    pointOverrides: Buffer.from('points'),
    documentExclusions: Buffer.from('documents')
  })
  const content = manifestLines(
    {territory: 'DEP-974', backupId: 'backup-1', transformationContract},
    [{kind: 'point', data: {b: 2, a: 1}}]
  )
  const parsed = readManifestContent(content)

  t.is(parsed.header.backupId, 'backup-1')
  t.deepEqual(groupManifestRecords(parsed.records).get('point'), [{a: 1, b: 2}])
  t.regex(sha256(content), /^[a-f\d]{64}$/)
  t.true(content.includes('"a":1,"b":2'))
})

test('le contrat de transformation fige les trois fichiers octet par octet', t => {
  const contents = {
    usageMap: Buffer.from('usage\n'),
    pointOverrides: Buffer.from('points\n'),
    documentExclusions: Buffer.from('documents\n')
  }
  const contract = buildTransformationContract(contents)

  t.is(contract.transformerVersion, TRANSFORMER_VERSION)
  t.notThrows(() => assertTransformationContract(contract, {...contents}))

  for (const key of Object.keys(contents)) {
    t.throws(() => assertTransformationContract(contract, {
      ...contents,
      [key]: Buffer.concat([contents[key], Buffer.from('x')])
    }), {message: /Fichier de transformation différent/})
  }

  t.throws(() => assertTransformationContract(undefined, contents), {
    message: /Contrat de transformation absent/
  })
  t.throws(() => assertTransformationContract({
    ...contract,
    transformerVersion: '999.0.0'
  }, contents), {message: /Version de transformateur incompatible/})
})

test('un ancien manifeste ou un manifeste v2 sans contrat est refusé', t => {
  const record = '{"kind":"header","manifestVersion":1}'
  t.throws(() => readManifestContent(`${record}\n`), {message: /Version de manifeste non supportée/})

  t.throws(() => readManifestContent(
    '{"kind":"header","manifestVersion":2}\n'
  ), {message: /Contrat de transformation absent/})
})

test('documents et règles partagés sont partitionnés par propriétaire', t => {
  const exploitations = [
    {_id: 'e1', preleveur: 'p1', documents: ['d1']},
    {_id: 'e2', preleveur: 'p2', documents: ['d1']}
  ]
  const documents = [
    {_id: 'd1', preleveur: 'p1', objectKey: 'd1.pdf'},
    {_id: EXCLUDED_DOCUMENT_ID, preleveur: 'p1', objectKey: 'missing.pdf'}
  ]
  const rules = [{
    _id: 'r1',
    exploitations: ['e1', 'e2'],
    document: 'd1'
  }, {
    _id: 'r2',
    exploitations: ['e1'],
    document: EXCLUDED_DOCUMENT_ID
  }]
  const excludedDocumentIds = new Set([EXCLUDED_DOCUMENT_ID])

  const documentPlans = partitionDocuments({documents, exploitations, rules, excludedDocumentIds})
  const rulePlans = partitionRules({rules, exploitations, excludedDocumentIds})

  t.deepEqual(documentPlans.map(plan => [plan.ownerId, plan.exploitationIds]), [
    ['p1', ['e1']],
    ['p2', ['e2']]
  ])
  t.deepEqual(rulePlans.map(plan => [plan.ruleId, plan.ownerId, plan.documentId]), [
    ['r1', 'p1', 'd1'],
    ['r1', 'p2', 'd1'],
    ['r2', 'p1', null]
  ])
})

test('un email déclarant ambigu ou utilisé par un agent reste un contact sans login', t => {
  const sourceEmailOwners = new Map([
    ['shared@example.test', new Set(['p1', 'p2'])],
    ['agent@example.test', new Set(['p3'])],
    ['safe@example.test', new Set(['p4'])]
  ])
  const agentEmails = new Set(['agent@example.test'])
  const targetEmailOwners = new Map()

  t.is(chooseDeclarantLoginEmail({
    declarant: {email: 'shared@example.test'},
    sourceEmailOwners,
    agentEmails,
    targetEmailOwners
  }), null)
  t.is(chooseDeclarantLoginEmail({
    declarant: {email: 'agent@example.test'},
    sourceEmailOwners,
    agentEmails,
    targetEmailOwners
  }), null)
  t.is(chooseDeclarantLoginEmail({
    declarant: {email: 'SAFE@example.test'},
    sourceEmailOwners,
    agentEmails,
    targetEmailOwners
  }), 'safe@example.test')
})

test('réconciliation contacts utilise l’email stable, retire les sources absentes et préserve existing', t => {
  const initial = buildDeclarantContactPlan({
    declarantLegacyId: 42,
    emails: ['primary@example.test', 'secondary@example.test'],
    current: []
  })
  const reordered = buildDeclarantContactPlan({
    declarantLegacyId: 42,
    emails: ['secondary@example.test', 'primary@example.test'],
    current: []
  })

  t.is(
    initial.expected.find(item => item.email === 'primary@example.test').sourceId,
    reordered.expected.find(item => item.email === 'primary@example.test').sourceId
  )

  const existing = initial.expected.map((item, index) => ({id: `managed-${index}`, ...item}))
  existing.push({
    id: 'existing-manual',
    email: 'manual@example.test',
    isPrimary: false,
    sourceId: 'existing:user:123'
  })
  const removal = buildDeclarantContactPlan({
    declarantLegacyId: 42,
    emails: ['primary@example.test'],
    current: existing
  })

  t.deepEqual(removal.staleIds, ['managed-1'])
  t.false(removal.unchanged)
  t.false(removal.staleIds.includes('existing-manual'))

  const reconciled = buildDeclarantContactPlan({
    declarantLegacyId: 42,
    emails: ['primary@example.test'],
    current: [
      {id: 'managed-0', ...removal.expected[0]},
      existing.at(-1)
    ]
  })
  t.true(reconciled.unchanged)

  const noSourceContact = buildDeclarantContactPlan({
    declarantLegacyId: 42,
    emails: [],
    current: [{
      id: 'existing-manual',
      email: 'manual@example.test',
      isPrimary: true,
      sourceId: 'existing:user:123'
    }]
  })
  t.true(noSourceContact.unchanged)
})

test('préflight pur couvre relations, checksums et exclusion documentaire', t => {
  const groups = new Map([
    ['declarant', [{_id: 'p1'}]],
    ['point', [{_id: 'pt1', id_point: 1, type_milieu: 'Eau de surface', geom: {coordinates: [55.5, -21.1]}}]],
    ['exploitation', [{
      _id: 'e1',
      id_exploitation: 12,
      preleveur: 'p1',
      point: 'pt1',
      statut: 'En activité',
      documents: ['d1']
    }]],
    ['agent', []],
    ['document', [{_id: 'd1', objectKey: 'd1.pdf', s3: {sha256: 'a'.repeat(64)}}]],
    ['rule', [{_id: 'r1', exploitations: ['e1'], document: EXCLUDED_DOCUMENT_ID}]]
  ])
  const usageMap = parseUsageMap(`legacy_exploitation_id,source_usage_codes,primary_usage_code,secondary_usage_codes,provenance
12,5A,5,,ods
`)
  const result = buildPreflight({
    groups,
    usageMap,
    pointOverrides: new Map(),
    excludedDocumentIds: new Set([EXCLUDED_DOCUMENT_ID])
  })

  t.true(result.ok)
  t.deepEqual(result.counts, {
    declarants: 1,
    points: 1,
    exploitations: 1,
    agents: 0,
    documents: 1,
    rules: 1
  })

  const unsupportedZone = buildPreflight({
    groups,
    usageMap,
    pointOverrides: new Map([['1', {forcedZoneCode: 'reg-99'}]]),
    excludedDocumentIds: new Set([EXCLUDED_DOCUMENT_ID])
  })
  t.true(unsupportedZone.issues.some(issue => issue.code === 'UNSUPPORTED_FORCED_ZONE'))
})

test('préflight bloque une référence documentaire exploitation absente sauf exclusion explicite', t => {
  const missingDocumentId = 'missing-document'
  const groups = new Map([
    ['declarant', [{_id: 'p1'}]],
    ['point', [{_id: 'pt1', id_point: 1, type_milieu: 'Eau de surface', geom: {coordinates: [55.5, -21.1]}}]],
    ['exploitation', [{
      _id: 'e1',
      id_exploitation: 12,
      preleveur: 'p1',
      point: 'pt1',
      statut: 'En activité',
      documents: [missingDocumentId]
    }]],
    ['agent', []],
    ['document', []],
    ['rule', []]
  ])
  const usageMap = parseUsageMap(`legacy_exploitation_id,source_usage_codes,primary_usage_code,secondary_usage_codes,provenance
12,5A,5,,ods
`)
  const run = excludedDocumentIds => buildPreflight({
    groups,
    usageMap,
    pointOverrides: new Map(),
    excludedDocumentIds: new Set([EXCLUDED_DOCUMENT_ID, ...excludedDocumentIds])
  })

  const blocked = run([])
  t.false(blocked.ok)
  t.true(blocked.issues.some(issue => issue.code === 'MISSING_EXPLOITATION_DOCUMENT_REFERENCE'))
  t.true(run([missingDocumentId]).ok)
})
