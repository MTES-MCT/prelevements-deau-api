const permission = ({code, label, description, requires = [], readOnly = false}) => ({
  code,
  label,
  description,
  requires,
  readOnly
})

export const ZONE_PERMISSION_GROUPS = Object.freeze([
  {
    code: 'zone',
    label: 'Zone et tableau de bord',
    permissions: [
      permission({
        code: 'zone.detail.read',
        label: 'Consulter la zone',
        description: 'Voir la vue d’ensemble et les informations générales de la zone.',
        readOnly: true
      }),
      permission({
        code: 'zone.geometry.read',
        label: 'Consulter le périmètre géographique',
        description: 'Afficher la géométrie et les limites cartographiques de la zone.',
        requires: ['zone.detail.read'],
        readOnly: true
      }),
      permission({
        code: 'zone.dashboard.read',
        label: 'Consulter le tableau de bord',
        description: 'Accéder aux chiffres clés, prélèvements et ressources en eau de la zone.',
        readOnly: true
      }),
      permission({
        code: 'zone.export',
        label: 'Exporter la liste des zones',
        description: 'Inclure cette zone dans l’export Excel de la liste des zones.',
        requires: ['zone.detail.read']
      })
    ]
  },
  {
    code: 'zone-resources',
    label: 'Paramétrage des ressources en eau',
    permissions: [
      permission({
        code: 'zone.resource.list',
        label: 'Consulter les ressources paramétrées',
        description: 'Voir les piézomètres et stations de débit associés à la zone.',
        requires: ['zone.detail.read'],
        readOnly: true
      }),
      permission({
        code: 'zone.resource.create',
        label: 'Ajouter une ressource',
        description: 'Associer un piézomètre ou une station de débit à la zone.',
        requires: ['zone.resource.list']
      }),
      permission({
        code: 'zone.resource.update',
        label: 'Modifier une ressource',
        description: 'Modifier le libellé, les codes ou l’état actif d’une ressource.',
        requires: ['zone.resource.list']
      }),
      permission({
        code: 'zone.resource.delete',
        label: 'Supprimer une ressource',
        description: 'Retirer une ressource du paramétrage de la zone.',
        requires: ['zone.resource.list']
      })
    ]
  },
  {
    code: 'zone-declaration-settings',
    label: 'Paramètres de déclaration',
    permissions: [
      permission({
        code: 'zone.declaration.settings.read',
        label: 'Consulter les paramètres',
        description: 'Voir la périodicité et les règles de déclaration de la zone.',
        requires: ['zone.detail.read'],
        readOnly: true
      }),
      permission({
        code: 'zone.declaration.settings.update',
        label: 'Modifier les paramètres',
        description: 'Modifier la périodicité et les règles de déclaration de la zone.',
        requires: ['zone.declaration.settings.read']
      }),
      permission({
        code: 'zone.declaration.override.create',
        label: 'Ajouter une dérogation de période',
        description: 'Créer une période dérogatoire dans le calendrier des déclarations.',
        requires: ['zone.declaration.settings.read']
      }),
      permission({
        code: 'zone.declaration.override.update',
        label: 'Modifier une dérogation de période',
        description: 'Modifier une période dérogatoire existante.',
        requires: ['zone.declaration.settings.read']
      }),
      permission({
        code: 'zone.declaration.override.delete',
        label: 'Supprimer une dérogation de période',
        description: 'Supprimer une période dérogatoire existante.',
        requires: ['zone.declaration.settings.read']
      })
    ]
  },
  {
    code: 'declarations',
    label: 'Déclarations',
    permissions: [
      permission({
        code: 'declaration.list',
        label: 'Voir la liste des déclarations',
        description: 'Consulter les déclarations qui concernent la zone.',
        readOnly: true
      }),
      permission({
        code: 'declaration.detail.read',
        label: 'Voir le détail d’une déclaration',
        description: 'Consulter les données, lignes et traitements d’une déclaration.',
        requires: ['declaration.list'],
        readOnly: true
      }),
      permission({
        code: 'declaration.file.download',
        label: 'Télécharger les fichiers déposés',
        description: 'Télécharger les fichiers sources associés à une déclaration.',
        requires: ['declaration.detail.read'],
        readOnly: true
      }),
      permission({
        code: 'declaration.instruct',
        label: 'Instruire une déclaration',
        description: 'Valider, rejeter ou commenter les lignes d’une déclaration.',
        requires: ['declaration.detail.read']
      }),
      permission({
        code: 'declaration.reconcile',
        label: 'Rapprocher les points',
        description: 'Associer ou détacher les lignes d’un fichier aux points de prélèvement.',
        requires: ['declaration.detail.read']
      }),
      permission({
        code: 'declaration.followup.read',
        label: 'Consulter le suivi des déclarations',
        description: 'Voir les déclarations attendues, reçues et manquantes de la zone.',
        requires: ['zone.detail.read'],
        readOnly: true
      }),
      permission({
        code: 'declaration.followup.export',
        label: 'Exporter les déclarations manquantes',
        description: 'Télécharger le fichier Excel des déclarations manquantes.',
        requires: ['declaration.followup.read']
      })
    ]
  },
  {
    code: 'points',
    label: 'Points de prélèvement',
    permissions: [
      permission({
        code: 'pp.list',
        label: 'Voir la liste des points',
        description: 'Consulter la liste des points de prélèvement de la zone.',
        requires: ['zone.detail.read'],
        readOnly: true
      }),
      permission({
        code: 'pp.map.read',
        label: 'Voir la carte des points',
        description: 'Afficher les points de prélèvement sur la carte.',
        readOnly: true
      }),
      permission({
        code: 'pp.export',
        label: 'Exporter les points',
        description: 'Télécharger la liste des points au format Excel.',
        requires: ['pp.list']
      }),
      permission({
        code: 'pp.detail.read',
        label: 'Voir le détail d’un point',
        description: 'Consulter les informations détaillées d’un point de prélèvement.',
        requires: ['pp.list'],
        readOnly: true
      }),
      permission({
        code: 'pp.volumes.read',
        label: 'Voir les mesures d’un point',
        description: 'Consulter les index et volumes associés à un point.',
        requires: ['pp.detail.read'],
        readOnly: true
      }),
      permission({
        code: 'pp.create',
        label: 'Créer un point',
        description: 'Créer un point de prélèvement dans la zone.',
        requires: ['pp.list', 'zone.geometry.read']
      }),
      permission({
        code: 'pp.update',
        label: 'Modifier un point',
        description: 'Modifier les informations d’un point de prélèvement.',
        requires: ['pp.detail.read', 'zone.geometry.read']
      }),
      permission({
        code: 'pp.delete',
        label: 'Supprimer un point',
        description: 'Supprimer un point de prélèvement.',
        requires: ['pp.detail.read']
      })
    ]
  },
  {
    code: 'exploitations',
    label: 'Exploitations',
    permissions: [
      permission({
        code: 'exploitation.list',
        label: 'Voir la liste des exploitations',
        description: 'Consulter les exploitations rattachées aux points de la zone.',
        requires: ['zone.detail.read'],
        readOnly: true
      }),
      permission({
        code: 'exploitation.export',
        label: 'Exporter les exploitations',
        description: 'Télécharger la liste des exploitations au format Excel.',
        requires: ['exploitation.list']
      }),
      permission({
        code: 'exploitation.detail.read',
        label: 'Voir le détail d’une exploitation',
        description: 'Consulter les informations détaillées d’une exploitation.',
        requires: ['exploitation.list'],
        readOnly: true
      }),
      permission({
        code: 'exploitation.volumes.read',
        label: 'Voir les mesures d’une exploitation',
        description: 'Consulter les index et volumes associés à une exploitation.',
        requires: ['exploitation.detail.read'],
        readOnly: true
      }),
      permission({
        code: 'exploitation.create',
        label: 'Créer une exploitation',
        description: 'Rattacher un préleveur à un point de la zone.',
        requires: ['exploitation.list', 'pp.list', 'declarant.list']
      }),
      permission({
        code: 'exploitation.update',
        label: 'Modifier une exploitation',
        description: 'Modifier une exploitation, son usage ou ses collecteurs.',
        requires: ['exploitation.detail.read', 'pp.list', 'declarant.list']
      }),
      permission({
        code: 'exploitation.delete',
        label: 'Supprimer une exploitation',
        description: 'Supprimer le rattachement entre un préleveur et un point.',
        requires: ['exploitation.detail.read']
      })
    ]
  },
  {
    code: 'declarants',
    label: 'Déclarants et collecteurs',
    permissions: [
      permission({
        code: 'declarant.list',
        label: 'Voir la liste des déclarants',
        description: 'Consulter les préleveurs et collecteurs de la zone.',
        requires: ['zone.detail.read'],
        readOnly: true
      }),
      permission({
        code: 'declarant.export',
        label: 'Exporter les déclarants',
        description: 'Télécharger les listes de préleveurs et collecteurs au format Excel.',
        requires: ['declarant.list']
      }),
      permission({
        code: 'declarant.detail.read',
        label: 'Voir le détail d’un déclarant',
        description: 'Consulter l’identité et les informations d’un préleveur ou collecteur.',
        requires: ['declarant.list'],
        readOnly: true
      }),
      permission({
        code: 'declarant.volumes.read',
        label: 'Voir les mesures d’un déclarant',
        description: 'Consulter les index et volumes associés à un déclarant.',
        requires: ['declarant.detail.read'],
        readOnly: true
      }),
      permission({
        code: 'declarant.create',
        label: 'Créer un déclarant',
        description: 'Créer un préleveur ou collecteur et le rattacher à la zone.',
        requires: ['declarant.list']
      }),
      permission({
        code: 'declarant.invite',
        label: 'Inviter un déclarant',
        description: 'Envoyer ou renvoyer l’email de création de compte.',
        requires: ['declarant.detail.read']
      }),
      permission({
        code: 'declarant.update',
        label: 'Modifier un déclarant',
        description: 'Modifier l’identité et les options d’un préleveur ou collecteur.',
        requires: ['declarant.detail.read']
      }),
      permission({
        code: 'declarant.delete',
        label: 'Supprimer un déclarant',
        description: 'Supprimer un préleveur ou collecteur.',
        requires: ['declarant.detail.read']
      }),
      permission({
        code: 'declarant.reminder.send',
        label: 'Envoyer un rappel',
        description: 'Envoyer manuellement un rappel de déclaration.',
        requires: ['declarant.detail.read']
      }),
      permission({
        code: 'declarant.zone.update',
        label: 'Gérer les zones d’un déclarant',
        description: 'Ajouter ou retirer les rattachements explicites du déclarant à des zones.',
        requires: ['declarant.detail.read']
      }),
      permission({
        code: 'declarant.declaration-type.read',
        label: 'Voir les types autorisés',
        description: 'Consulter les types de déclaration autorisés pour le déclarant.',
        requires: ['declarant.detail.read'],
        readOnly: true
      }),
      permission({
        code: 'declarant.declaration-type.update',
        label: 'Modifier les types autorisés',
        description: 'Ajouter, modifier ou retirer un type de déclaration autorisé.',
        requires: ['declarant.declaration-type.read']
      }),
      permission({
        code: 'declarant.email-alias.read',
        label: 'Voir les alias d’email',
        description: 'Consulter les adresses email secondaires du déclarant.',
        requires: ['declarant.detail.read'],
        readOnly: true
      }),
      permission({
        code: 'declarant.email-alias.update',
        label: 'Modifier les alias d’email',
        description: 'Ajouter ou supprimer une adresse email secondaire.',
        requires: ['declarant.email-alias.read']
      }),
      permission({
        code: 'declarant.rule.read',
        label: 'Voir les règles',
        description: 'Consulter les règles de gestion du déclarant.',
        requires: ['declarant.detail.read'],
        readOnly: true
      }),
      permission({
        code: 'declarant.rule.create',
        label: 'Créer une règle',
        description: 'Créer une règle de gestion pour le déclarant.',
        requires: ['declarant.rule.read', 'exploitation.list']
      }),
      permission({
        code: 'declarant.rule.update',
        label: 'Modifier une règle',
        description: 'Modifier une règle de gestion du déclarant.',
        requires: ['declarant.rule.read', 'exploitation.list']
      }),
      permission({
        code: 'declarant.rule.delete',
        label: 'Supprimer une règle',
        description: 'Supprimer une règle de gestion du déclarant.',
        requires: ['declarant.rule.read']
      }),
      permission({
        code: 'declarant.document.read',
        label: 'Voir les documents',
        description: 'Consulter et télécharger les documents du déclarant.',
        requires: ['declarant.detail.read'],
        readOnly: true
      }),
      permission({
        code: 'declarant.document.create',
        label: 'Ajouter un document',
        description: 'Ajouter un document au dossier du déclarant.',
        requires: ['declarant.document.read']
      }),
      permission({
        code: 'declarant.document.update',
        label: 'Modifier un document',
        description: 'Modifier les informations d’un document.',
        requires: ['declarant.document.read']
      }),
      permission({
        code: 'declarant.document.delete',
        label: 'Supprimer un document',
        description: 'Supprimer un document du dossier du déclarant.',
        requires: ['declarant.document.read']
      })
    ]
  },
  {
    code: 'agents',
    label: 'Agents de la zone',
    permissions: [
      permission({
        code: 'zone.agent.list',
        label: 'Voir la liste des agents',
        description: 'Consulter les agents rattachés à la zone.',
        requires: ['zone.detail.read'],
        readOnly: true
      }),
      permission({
        code: 'zone.agent.export',
        label: 'Exporter les agents',
        description: 'Télécharger la liste des agents au format Excel.',
        requires: ['zone.agent.list']
      }),
      permission({
        code: 'zone.agent.detail.read',
        label: 'Voir le détail d’un agent',
        description: 'Consulter les coordonnées, la période et les droits d’un agent.',
        requires: ['zone.agent.list'],
        readOnly: true
      }),
      permission({
        code: 'zone.agent.create',
        label: 'Ajouter un agent',
        description: 'Créer ou rattacher un agent à la zone.',
        requires: ['zone.agent.list']
      }),
      permission({
        code: 'zone.agent.update',
        label: 'Modifier les droits d’un agent',
        description: 'Modifier la période et les droits d’un autre agent.',
        requires: ['zone.agent.detail.read']
      }),
      permission({
        code: 'zone.agent.remove',
        label: 'Retirer un agent',
        description: 'Retirer le rattachement d’un agent à la zone.',
        requires: ['zone.agent.detail.read']
      }),
      permission({
        code: 'zone.agent.notify',
        label: 'Envoyer les emails d’accès',
        description: 'Envoyer ou renvoyer les emails de compte et de rattachement.',
        requires: ['zone.agent.detail.read']
      })
    ]
  },
  {
    code: 'exports',
    label: 'Exports de données',
    permissions: [
      permission({
        code: 'export.volumes',
        label: 'Exporter les mesures',
        description: 'Créer, consulter, télécharger et supprimer ses exports d’index et de volumes.'
      })
    ]
  }
])

export const ZONE_PERMISSION_CATALOG = Object.freeze(
  ZONE_PERMISSION_GROUPS.flatMap(group => group.permissions.map(item => Object.freeze({
    ...item,
    groupCode: group.code,
    groupLabel: group.label
  })))
)

export const ZONE_PERMISSION_CODES = Object.freeze(ZONE_PERMISSION_CATALOG.map(item => item.code))
export const ZONE_PERMISSION_CODE_SET = new Set(ZONE_PERMISSION_CODES)

export const READ_ONLY_ZONE_PERMISSIONS = Object.freeze(
  ZONE_PERMISSION_CATALOG.filter(item => item.readOnly).map(item => item.code)
)

const LEGACY_EXTRA_PERMISSIONS = [
  'zone.export',
  'declaration.instruct',
  'declaration.reconcile',
  'declaration.followup.export',
  'pp.export',
  'exploitation.export',
  'declarant.export',
  'zone.agent.export',
  'export.volumes'
]

export const LEGACY_INSTRUCTOR_ZONE_PERMISSIONS = Object.freeze([
  ...new Set([...READ_ONLY_ZONE_PERMISSIONS, ...LEGACY_EXTRA_PERMISSIONS])
])

export const ZONE_AGENT_MANAGEMENT_PERMISSIONS = Object.freeze([
  'zone.agent.create',
  'zone.agent.update',
  'zone.agent.remove'
])

const catalogByCode = new Map(ZONE_PERMISSION_CATALOG.map(item => [item.code, item]))

export function isZonePermission(value) {
  return ZONE_PERMISSION_CODE_SET.has(value)
}

export function sortZonePermissions(values = []) {
  const indexByCode = new Map(ZONE_PERMISSION_CODES.map((code, index) => [code, index]))

  return [...new Set(values)]
    .filter(isZonePermission)
    .sort((left, right) => indexByCode.get(left) - indexByCode.get(right))
}

export function getMissingPermissionDependencies(values = []) {
  const selected = new Set(values)
  const missing = []

  for (const code of selected) {
    const item = catalogByCode.get(code)
    for (const requiredCode of item?.requires ?? []) {
      if (!selected.has(requiredCode)) {
        missing.push({permission: code, requires: requiredCode})
      }
    }
  }

  return missing
}

export function withPermissionDependencies(values = []) {
  const selected = new Set(values.filter(isZonePermission))
  let changed = true

  while (changed) {
    changed = false

    for (const code of selected) {
      for (const requiredCode of catalogByCode.get(code)?.requires ?? []) {
        if (!selected.has(requiredCode)) {
          selected.add(requiredCode)
          changed = true
        }
      }
    }
  }

  return sortZonePermissions([...selected])
}

export function withoutPermissionDependents(values = [], removedCode) {
  const selected = new Set(values.filter(code => code !== removedCode))
  let changed = true

  while (changed) {
    changed = false

    for (const code of selected) {
      const requirements = catalogByCode.get(code)?.requires ?? []
      if (requirements.some(requiredCode => !selected.has(requiredCode))) {
        selected.delete(code)
        changed = true
      }
    }
  }

  return sortZonePermissions([...selected])
}

export function serializeZonePermissionCatalog() {
  return ZONE_PERMISSION_GROUPS.map(group => ({
    code: group.code,
    label: group.label,
    permissions: group.permissions.map(item => ({...item}))
  }))
}
