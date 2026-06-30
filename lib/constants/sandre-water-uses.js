const ROOT_USAGE_COLORS = {
  0: '#6A6A6A',
  1: '#DADADA',
  2: '#2E7D32',
  3: '#6B7F2A',
  4: '#B3404A',
  5: '#1D70B8',
  6: '#C97900',
  7: '#8A55B5',
  8: '#008C95',
  9: '#7E4EAD',
  10: '#CE3A2B',
  11: '#008577',
  12: '#0096A6',
  13: '#0063CB',
  14: '#B06F00',
  15: '#6A6A6A',
  16: '#2F6C9C',
  17: '#6F5B3E'
}

const ROOT_USAGE_TEXT_COLORS = {
  1: '#161616',
  6: '#161616',
  15: '#FFFFFF'
}

const RAW_SANDRE_WATER_USES = [
  {code: '0', kind: 'USAGE', label: 'Usage inconnu', mnemonic: 'INCONNU'},
  {code: '1', kind: 'USAGE', label: 'Pas d’usage', mnemonic: 'PAS D’USAGE'},
  {code: '2', kind: 'USAGE', label: 'Irrigation', mnemonic: 'IRRIGATION'},
  {code: '2A', kind: 'SUB_USAGE', parentCode: '2', label: 'Irrigation par aspersion', mnemonic: 'Irrig. asp'},
  {code: '2B', kind: 'SUB_USAGE', parentCode: '2', label: 'Irrigation gravitaire', mnemonic: 'Irrig. grav.'},
  {code: '2C', kind: 'SUB_USAGE', parentCode: '2', label: 'Irrigation au goutte à goutte', mnemonic: 'Irrig. gout'},
  {code: '2D', kind: 'SUB_USAGE', parentCode: '2', label: 'Irrigation par tout autre procédé', mnemonic: 'Irrig. autre'},
  {code: '2E', kind: 'SUB_USAGE', parentCode: '2', label: 'Lutte antigel de cultures pérennes', mnemonic: 'Lutte antigel'},
  {code: '2F', kind: 'SUB_USAGE', parentCode: '2', label: 'Volume technique d’irrigation', mnemonic: 'Irrig. vol. tech.'},
  {code: '3', kind: 'USAGE', label: 'Agriculture-élevage (hors irrigation)', mnemonic: 'AGRICULTURE-ELEVAGE'},
  {code: '3A', kind: 'SUB_USAGE', parentCode: '3', label: 'Abreuvage', mnemonic: 'Abreuvage'},
  {code: '3B', kind: 'SUB_USAGE', parentCode: '3', label: 'Aquaculture', mnemonic: 'Aquaculture'},
  {code: '4', kind: 'USAGE', label: 'Industrie', mnemonic: 'INDUSTRIE'},
  {code: '4A', kind: 'SUB_USAGE', parentCode: '4', label: 'Agro-alimentaire', mnemonic: 'Agro-alim.'},
  {code: '4B', kind: 'SUB_USAGE', parentCode: '4', label: 'Industrie hors agro-alimentaire', mnemonic: 'Ind. hors AA'},
  {code: '4C', kind: 'SUB_USAGE', parentCode: '4', label: 'Exhaure', mnemonic: 'Exhaure'},
  {code: '4D', kind: 'SUB_USAGE', parentCode: '4', label: 'Refroidissement avec restitution supérieure à 99 %', mnemonic: 'Refroid. >99%'},
  {code: '5', kind: 'USAGE', label: 'Alimentation en eau potable (AEP)', mnemonic: 'AEP'},
  {code: '5A', kind: 'SUB_USAGE', parentCode: '5', label: 'Alimentation collective', mnemonic: 'AEP coll.'},
  {code: '5B', kind: 'SUB_USAGE', parentCode: '5', label: 'Alimentation individuelle', mnemonic: 'AEP indiv.'},
  {code: '6', kind: 'USAGE', label: 'Énergie', mnemonic: 'ENERGIE'},
  {code: '6A', kind: 'SUB_USAGE', parentCode: '6', label: 'Pompe à chaleur', mnemonic: 'PAC'},
  {code: '6B', kind: 'SUB_USAGE', parentCode: '6', label: 'Géothermie', mnemonic: 'Géothermie'},
  {code: '6C', kind: 'SUB_USAGE', parentCode: '6', label: 'Refroidissement de centrales de production d’énergie', mnemonic: 'Refroid. centr.'},
  {code: '6C1', kind: 'SUB_USAGE', parentCode: '6', label: 'Refroidissement de centrales thermiques', mnemonic: 'Refroid. therm.'},
  {code: '6C2', kind: 'SUB_USAGE', parentCode: '6', label: 'Refroidissement de centrales nucléaires', mnemonic: 'Refroid. nucl.'},
  {code: '6C3', kind: 'SUB_USAGE', parentCode: '6', label: 'Refroidissement des centrales de production électrique', mnemonic: 'Refroid. élec.'},
  {code: '6D', kind: 'SUB_USAGE', parentCode: '6', label: 'Barrages hydro-électriques - force motrice', mnemonic: 'Hydro-élec.'},
  {code: '7', kind: 'USAGE', label: 'Loisirs', mnemonic: 'LOISIRS'},
  {code: '7A', kind: 'SUB_USAGE', parentCode: '7', label: 'Bassin de natation', mnemonic: 'Natation'},
  {code: '7B', kind: 'SUB_USAGE', parentCode: '7', label: 'Baignade', mnemonic: 'Baignade'},
  {code: '7C', kind: 'SUB_USAGE', parentCode: '7', label: 'Autres activités de loisir', mnemonic: 'Loisir autre'},
  {code: '7D', kind: 'SUB_USAGE', parentCode: '7', label: 'Arrosage', mnemonic: 'Arrosage'},
  {code: '7E', kind: 'SUB_USAGE', parentCode: '7', label: 'Canon à neige', mnemonic: 'Canon neige'},
  {code: '8', kind: 'USAGE', label: 'Embouteillage', mnemonic: 'EMBOUTEILLAGE'},
  {code: '9', kind: 'USAGE', label: 'Thermalisme et thalassothérapie', mnemonic: 'THERMALISME'},
  {code: '9A', kind: 'SUB_USAGE', parentCode: '9', label: 'Thermalisme', mnemonic: 'Thermalisme'},
  {code: '9B', kind: 'SUB_USAGE', parentCode: '9', label: 'Thalassothérapie', mnemonic: 'Thalasso'},
  {code: '10', kind: 'USAGE', label: 'Défense contre incendie', mnemonic: 'DEFENSE INCENDIE'},
  {code: '11', kind: 'USAGE', label: 'Dépollution', mnemonic: 'DEPOLLUTION'},
  {code: '12', kind: 'USAGE', label: 'Réalimentation d’une ressource en eau', mnemonic: 'REALIMENTATION'},
  {code: '12A', kind: 'SUB_USAGE', parentCode: '12', label: 'Soutien d’étiage', mnemonic: 'Soutien étiage'},
  {code: '12B', kind: 'SUB_USAGE', parentCode: '12', label: 'Compensation évaporation', mnemonic: 'Comp. évap.'},
  {code: '12C', kind: 'SUB_USAGE', parentCode: '12', label: 'Compensation irrigation', mnemonic: 'Comp. irrig.'},
  {code: '12D', kind: 'SUB_USAGE', parentCode: '12', label: 'Compensation salubrité', mnemonic: 'Comp. salubr.'},
  {code: '12E', kind: 'SUB_USAGE', parentCode: '12', label: 'Remplissage plan d’eau', mnemonic: 'Rempl. plan'},
  {code: '13', kind: 'USAGE', label: 'Canaux', mnemonic: 'CANAUX'},
  {code: '13A', kind: 'SUB_USAGE', parentCode: '13', label: 'Volume technique de navigation', mnemonic: 'Vol. nav.'},
  {code: '13B', kind: 'SUB_USAGE', parentCode: '13', label: 'Alimentation au soutien canal', mnemonic: 'Soutien canal'},
  {code: '14', kind: 'USAGE', label: 'Soutien d’étiage', mnemonic: 'SOUTIEN ETIAGE'},
  {code: '15', kind: 'USAGE', label: 'Entretien de voiries', mnemonic: 'VOIRIES'},
  {code: '16', kind: 'USAGE', label: 'Alimentation au soutien canal', mnemonic: 'SOUTIEN CANAL'},
  {code: '17', kind: 'USAGE', label: 'Usage domestique', mnemonic: 'DOMESTIQUE'}
]

export const LEGACY_USAGE_TO_ROOT_USAGE_CODE = {
  INCONNU: '0',
  PAS_D_USAGE: '1',
  IRRIGATION: '2',
  AGRICULTURE_ELEVAGE: '3',
  AQUACULTURE: '3',
  INDUSTRIE: '4',
  AEP: '5',
  ENERGIE: '6',
  LOISIRS: '7',
  EMBOUTEILLAGE: '8',
  THERMALISME_THALASSO: '9',
  DEFENSE_INCENDIE: '10',
  REALIMENTATION_EAU: '12',
  CANAUX: '13',
  ETIAGE: '14',
  ENTRETIEN_VOIRIES: '15',
  ALIMENTATION_SOUTIEN_CANAL: '16',
  DOMESTIQUE: '17'
}

export const LEGACY_USAGE_TO_DECLARATION_USAGE_CODE = {
  ...LEGACY_USAGE_TO_ROOT_USAGE_CODE,
  AQUACULTURE: '3B'
}

export const ROOT_USAGE_CODE_TO_LEGACY_USAGE = {
  0: 'INCONNU',
  1: 'PAS_D_USAGE',
  2: 'IRRIGATION',
  3: 'AGRICULTURE_ELEVAGE',
  4: 'INDUSTRIE',
  5: 'AEP',
  6: 'ENERGIE',
  7: 'LOISIRS',
  8: 'EMBOUTEILLAGE',
  9: 'THERMALISME_THALASSO',
  10: 'DEFENSE_INCENDIE',
  12: 'REALIMENTATION_EAU',
  13: 'CANAUX',
  14: 'ETIAGE',
  15: 'ENTRETIEN_VOIRIES',
  16: 'ALIMENTATION_SOUTIEN_CANAL',
  17: 'DOMESTIQUE'
}

export const SANDRE_WATER_USES = RAW_SANDRE_WATER_USES.map(waterUse => {
  const rootCode = waterUse.kind === 'USAGE' ? waterUse.code : waterUse.parentCode
  const color = ROOT_USAGE_COLORS[rootCode] ?? ROOT_USAGE_COLORS[0]

  return {
    definition: null,
    status: 'Validé',
    dashboardVisible: !['0', '1'].includes(rootCode),
    color,
    textColor: ROOT_USAGE_TEXT_COLORS[rootCode] ?? '#FFFFFF',
    ...waterUse
  }
})

export const SANDRE_WATER_USES_BY_CODE = new Map(
  SANDRE_WATER_USES.map(waterUse => [waterUse.code, waterUse])
)

export const SANDRE_ROOT_WATER_USES = SANDRE_WATER_USES.filter(waterUse => waterUse.kind === 'USAGE')

export function normalizeWaterUseCode(value) {
  const rawValue = value && typeof value === 'object' && !Array.isArray(value)
    ? value.code
    : value
  const code = String(rawValue ?? '').trim().toLocaleUpperCase('fr-FR')
  return SANDRE_WATER_USES_BY_CODE.has(code) ? code : null
}

export function getWaterUse(code) {
  return SANDRE_WATER_USES_BY_CODE.get(normalizeWaterUseCode(code)) ?? null
}

export function isWaterUseCode(value) {
  return normalizeWaterUseCode(value) !== null
}

export function isRootWaterUseCode(value) {
  const waterUse = getWaterUse(value)
  return waterUse?.kind === 'USAGE'
}

export function getRootWaterUseCode(value) {
  const waterUse = getWaterUse(value)

  if (!waterUse) {
    return null
  }

  return waterUse.kind === 'USAGE' ? waterUse.code : waterUse.parentCode
}

export function legacyUsageToRootUsageCode(value) {
  const legacyCode = String(value ?? '').trim().toLocaleUpperCase('fr-FR')
  const code = LEGACY_USAGE_TO_ROOT_USAGE_CODE[legacyCode] ?? normalizeWaterUseCode(value)
  return getRootWaterUseCode(code)
}

export function legacyUsageToDeclarationUsageCode(value) {
  const legacyCode = String(value ?? '').trim().toLocaleUpperCase('fr-FR')
  return LEGACY_USAGE_TO_DECLARATION_USAGE_CODE[legacyCode] ?? normalizeWaterUseCode(value)
}

export function waterUseCodeToLegacyRootUsage(value) {
  const rootCode = getRootWaterUseCode(value)
  return rootCode ? ROOT_USAGE_CODE_TO_LEGACY_USAGE[rootCode] ?? null : null
}

export function getExploitationWaterUseCodes(exploitation) {
  const code = normalizeWaterUseCode(exploitation?.usage)

  if (code) {
    return [getRootWaterUseCode(code)].filter(Boolean)
  }

  return []
}

export function getPrimaryExploitationWaterUseCode(exploitation) {
  return getExploitationWaterUseCodes(exploitation)[0] ?? null
}

export function getDeclarationUsageOptions(rootUsageCode) {
  const normalizedRootCode = normalizeWaterUseCode(rootUsageCode)

  if (!normalizedRootCode) {
    return SANDRE_WATER_USES
  }

  const rootCode = getRootWaterUseCode(normalizedRootCode)
  return SANDRE_WATER_USES.filter(waterUse => waterUse.code === rootCode || waterUse.parentCode === rootCode)
}
