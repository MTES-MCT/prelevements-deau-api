import test from 'ava'

import {
  computeDebitsReservesStats,
  computeDocumentsStats,
  computePointStatusCounts,
  computeRegularisationsStats
} from '../stats.js'

const now = new Date('2026-06-30T00:00:00.000Z')

test('computePointStatusCounts applique le statut global des points', t => {
  const result = computePointStatusCounts([
    {declarants: [{status: 'TERMINEE'}, {status: 'EN_ACTIVITE'}]},
    {declarants: [{status: 'TERMINEE'}]},
    {declarants: [{status: 'ABANDONNEE'}]},
    {declarants: [{status: 'NON_RENSEIGNE'}]},
    {declarants: []}
  ])

  t.deepEqual(result, {
    enActivitePoints: 1,
    termineePoints: 1,
    abandoneePoints: 1,
    nonRenseignePoints: 2
  })
})

test('computeDocumentsStats groupe les documents exploitables par nature et année', t => {
  const result = computeDocumentsStats([
    {id: '1', nature: 'Autorisation IOTA', signatureDate: new Date('2024-05-01T00:00:00.000Z')},
    {id: '2', nature: 'Autorisation AOT', signatureDate: new Date('2023-01-01T00:00:00.000Z')},
    {id: '3', nature: null, signatureDate: new Date('2025-01-01T00:00:00.000Z')},
    {id: '4', nature: 'Autorisation ICPE', signatureDate: null}
  ])

  t.deepEqual(result, [
    {id: '2', nature: 'Autorisation AOT', annee: '2023'},
    {id: '1', nature: 'Autorisation IOTA', annee: '2024'}
  ])
})

test('computeRegularisationsStats compte les régimes concernés et autorisés', t => {
  const exploitations = [
    {
      usage: {code: '5A', label: 'Alimentation collective', mnemonic: 'AEP'},
      documents: [
        {nature: 'Autorisation CSP - IOTA', validityEndDate: null}
      ]
    },
    {
      usage: {code: '4', label: 'Industrie', mnemonic: 'INDUSTRIE'},
      documents: [
        {nature: 'Autorisation ICPE', validityEndDate: new Date('2027-01-01T00:00:00.000Z')}
      ]
    },
    {
      usage: {code: '6D', label: 'Hydroélectricité'},
      documents: [
        {nature: 'Autorisation hydroélectricité', validityEndDate: new Date('2025-01-01T00:00:00.000Z')}
      ]
    }
  ]

  const result = computeRegularisationsStats(exploitations, now)
  const byRegime = new Map(result.map(row => [row.regime, row]))

  t.like(byRegime.get('AOT'), {
    nb_exploitations_concernees: 3,
    nb_exploitations_autorisees: 0,
    nb_exploitations_non_autorisees: 3
  })
  t.like(byRegime.get('IOTA'), {
    nb_exploitations_concernees: 1,
    nb_exploitations_autorisees: 1
  })
  t.like(byRegime.get('CSP'), {
    nb_exploitations_concernees: 1,
    nb_exploitations_autorisees: 1
  })
  t.like(byRegime.get('ICPE'), {
    nb_exploitations_concernees: 1,
    nb_exploitations_autorisees: 1
  })
  t.like(byRegime.get('Hydroélectricité'), {
    nb_exploitations_concernees: 1,
    nb_exploitations_autorisees: 0
  })
})

test('computeDebitsReservesStats limite le calcul aux prélèvements de surface hors sources', t => {
  const result = computeDebitsReservesStats([
    {
      pointPrelevement: {name: 'Pompage rivière', waterBodyType: 'SUPERFICIELLE'},
      rules: [{resourceRule: {parameter: 'Débit réservé', validityEndDate: null}}]
    },
    {
      pointPrelevement: {name: 'Pompage canal', waterBodyType: 'SUPERFICIELLE'},
      rules: []
    },
    {
      pointPrelevement: {name: 'Source du vallon', waterBodyType: 'SUPERFICIELLE'},
      rules: [{resourceRule: {parameter: 'Débit réservé', validityEndDate: null}}]
    },
    {
      pointPrelevement: {name: 'Forage nord', waterBodyType: 'SOUTERRAIN'},
      rules: [{resourceRule: {parameter: 'Débit réservé', validityEndDate: null}}]
    }
  ])

  t.deepEqual(result, [
    {debitReserve: 'Débit réservé défini', nbExploitations: 1},
    {debitReserve: 'Pas de débit réservé', nbExploitations: 1}
  ])
})
