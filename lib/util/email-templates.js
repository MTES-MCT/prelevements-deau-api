import mjml2html from 'mjml'

function getDisplayName(user) {
  return [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || user?.email || 'utilisateur'
}

async function renderMjml(mjmlTemplate) {
  const {html, errors} = await mjml2html(mjmlTemplate, {
    validationLevel: 'soft'
  })

  if (errors && errors.length > 0) {
    console.warn('MJML warnings:', errors)
  }

  return html
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}

function renderContextRow(label, value) {
  if (!value) {
    return ''
  }

  return `
        <mj-text padding="0 0 6px 0">
          <strong>${escapeHtml(label)} :</strong> ${escapeHtml(value)}
        </mj-text>
  `
}

function renderContextLink(label, value, linkLabel = value) {
  if (!value) {
    return ''
  }

  return `
        <mj-text padding="0 0 6px 0">
          <strong>${escapeHtml(label)} :</strong> <a href="${escapeHtml(value)}">${escapeHtml(linkLabel)}</a>
        </mj-text>
  `
}

function renderContextList(label, values = []) {
  const cleanValues = values.filter(Boolean)

  if (cleanValues.length === 0) {
    return ''
  }

  return `
        <mj-text padding="8px 0 0 0">
          <strong>${escapeHtml(label)} :</strong>
          <ul>
            ${cleanValues.map(value => `<li>${escapeHtml(value)}</li>`).join('')}
          </ul>
        </mj-text>
  `
}

function formatEmailVerificationExpiration(expiresAt) {
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Paris'
  }).format(new Date(expiresAt))
}

export async function renderMagicLinkEmail(user, authToken, apiUrl) {
  const mjmlTemplate = `
<mjml>
  <mj-head>
    <mj-title>Connexion à Partageons l'eau</mj-title>
    <mj-attributes>
      <mj-all font-family="Arial, sans-serif" />
      <mj-text font-size="14px" color="#333333" line-height="1.6" />
      <mj-button background-color="#0066CC" color="#ffffff" border-radius="4px" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#f4f4f4">
    <mj-section background-color="#ffffff" padding="40px 20px">
      <mj-column>
        <mj-text font-size="24px" font-weight="bold" align="center" padding-bottom="20px">
          Partageons l'Eau
        </mj-text>
        <mj-text padding-bottom="20px">
          Bonjour ${getDisplayName(user)},
        </mj-text>
        <mj-text padding-bottom="20px">
          Vous avez demandé à vous connecter à l'application Partageons l'eau, cliquez sur le lien ci-dessous pour vous connecter&nbsp;:
        </mj-text>
        <mj-button href="${apiUrl}/auth/verify/${authToken}" padding="10px 0">
          Se connecter
        </mj-button>
        <mj-text padding-top="20px" font-size="12px" color="#666666">
          Ce lien est valable pendant 15 minutes.
        </mj-text>
        <mj-text font-size="12px" color="#666666">
          Si vous n'avez pas demandé cette connexion, ignorez cet email.
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
  `

  return renderMjml(mjmlTemplate)
}

export async function renderDeclarationPointsChangeRequestEmail({
  context,
  message
}) {
  const mjmlTemplate = `
<mjml>
  <mj-head>
    <mj-title>Demande d'ajout ou de modification de points - Partageons l'eau</mj-title>
    <mj-attributes>
      <mj-all font-family="Arial, sans-serif" />
      <mj-text font-size="14px" color="#333333" line-height="1.6" />
      <mj-section background-color="#ffffff" />
    </mj-attributes>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <mj-section padding="32px 20px">
      <mj-column>
        <mj-text font-size="22px" font-weight="bold" padding-bottom="16px">
          Demande d'ajout ou de modification de points
        </mj-text>

        <mj-text padding-bottom="16px">
          Un déclarant demande l'ajout ou la modification de points de prélèvement liés à sa déclaration.
        </mj-text>

        <mj-text font-size="16px" font-weight="bold" padding="12px 0 8px 0">
          Demande du déclarant
        </mj-text>
        <mj-text padding="0 0 16px 0" background-color="#f6f6f6">
          ${escapeHtml(message).replaceAll('\n', '<br />')}
        </mj-text>

        <mj-text font-size="16px" font-weight="bold" padding="12px 0 8px 0">
          Contexte
        </mj-text>
        ${renderContextRow('Déclaration', context.declarationLabel)}
        ${renderContextRow('Demandeur', context.requesterLabel)}
        ${renderContextLink('Déclaration en ligne', context.url, 'Ouvrir la déclaration')}
        ${renderContextRow('Statut', context.statusLabel)}
        ${renderContextRow('Période', context.periodLabel)}
        ${renderContextRow('Déclarant concerné', context.declarantLabel)}
        ${renderContextRow('Déposée par', context.createdByDeclarantLabel)}
        ${renderContextRow('Type de déclaration', context.declarationTypeLabel)}
        ${renderContextRow('Type de saisie', context.dataSourceTypeLabel)}
        ${renderContextRow('Lignes du fichier', context.chunkCountLabel)}
        ${renderContextRow('Points associés', context.matchedPointsLabel)}
        ${renderContextRow('Volume total prélevé', context.totalWithdrawnLabel)}
        ${renderContextList('Fichiers', context.fileLabels)}
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
  `

  return renderMjml(mjmlTemplate)
}

export async function renderAccountCreationEmail(user, appUrl) {
  const mjmlTemplate = `
<mjml>
  <mj-head>
    <mj-title>Votre compte Partageons l'eau est disponible</mj-title>
    <mj-attributes>
      <mj-all font-family="Arial, sans-serif" />
      <mj-text font-size="14px" color="#333333" line-height="1.6" />
      <mj-button background-color="#0063CB" color="#ffffff" border-radius="4px" />
    </mj-attributes>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <mj-section background-color="#ffffff" padding="40px 20px">
      <mj-column>
        <mj-text font-size="24px" font-weight="bold" align="center" padding-bottom="20px">
          Partageons l'Eau
        </mj-text>

        <mj-text padding-bottom="20px">
          Bonjour ${getDisplayName(user)},
        </mj-text>

        <mj-text padding-bottom="20px">
          Un compte vient d'être créé pour vous sur l'application Partageons l'Eau.
        </mj-text>

        <mj-text padding-bottom="20px">
          Vous pouvez vous connecter avec l'adresse email ${user.email}. Un lien de connexion sécurisé vous sera envoyé lors de votre connexion.
        </mj-text>

        <mj-button href="${appUrl}" padding="10px 0">
          Accéder à Partageons l'Eau
        </mj-button>

        <mj-text padding-top="20px" font-size="12px" color="#666666">
          Si vous n'êtes pas concerné par ce compte, vous pouvez ignorer ce message.
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
  `

  return renderMjml(mjmlTemplate)
}

export async function renderZoneAttachmentEmail(user, zone, appUrl) {
  const zoneLabel = [zone?.name, zone?.code ? `(${zone.code})` : null].filter(Boolean).join(' ')

  const mjmlTemplate = `
<mjml>
  <mj-head>
    <mj-title>Nouvel accès à une zone - Partageons l'eau</mj-title>
    <mj-attributes>
      <mj-all font-family="Arial, sans-serif" />
      <mj-text font-size="14px" color="#333333" line-height="1.6" />
      <mj-button background-color="#0063CB" color="#ffffff" border-radius="4px" />
    </mj-attributes>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <mj-section background-color="#ffffff" padding="40px 20px">
      <mj-column>
        <mj-text font-size="24px" font-weight="bold" align="center" padding-bottom="20px">
          Partageons l'Eau
        </mj-text>

        <mj-text padding-bottom="20px">
          Bonjour ${getDisplayName(user)},
        </mj-text>

        <mj-text padding-bottom="20px">
          Vous venez d'être rattaché à la zone ${zoneLabel} dans Partageons l'Eau.
        </mj-text>

        <mj-text padding-bottom="20px">
          Cette zone est maintenant disponible dans votre espace Mes zones.
        </mj-text>

        <mj-button href="${appUrl}/zones" padding="10px 0">
          Ouvrir mes zones
        </mj-button>

        <mj-text padding-top="20px" font-size="12px" color="#666666">
          Si vous pensez ne pas être concerné, contactez l'administrateur de votre zone.
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
  `

  return renderMjml(mjmlTemplate)
}

export async function renderEmailVerificationEmail({
  user,
  email,
  purpose,
  confirmationUrl,
  expiresAt
}) {
  const isPrimaryChange = purpose === 'PRIMARY_CHANGE'
  const actionLabel = isPrimaryChange
    ? 'Confirmer ma nouvelle adresse'
    : 'Confirmer cette adresse de connexion'
  const description = isPrimaryChange
    ? `Vous avez demandé à remplacer votre adresse de connexion par <strong>${escapeHtml(email)}</strong>.`
    : `Vous avez demandé à ajouter <strong>${escapeHtml(email)}</strong> comme autre adresse de connexion.`

  const mjmlTemplate = `
<mjml>
  <mj-head>
    <mj-title>Validation de votre adresse email - Partageons l'eau</mj-title>
    <mj-attributes>
      <mj-all font-family="Arial, sans-serif" />
      <mj-text font-size="14px" color="#333333" line-height="1.6" />
      <mj-button background-color="#0063CB" color="#ffffff" border-radius="4px" />
    </mj-attributes>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <mj-section background-color="#ffffff" padding="40px 20px">
      <mj-column>
        <mj-text font-size="24px" font-weight="bold" align="center" padding-bottom="20px">
          Partageons l'Eau
        </mj-text>

        <mj-text padding-bottom="20px">
          Bonjour ${escapeHtml(getDisplayName(user))},
        </mj-text>

        <mj-text padding-bottom="20px">
          ${description}
        </mj-text>

        <mj-text padding-bottom="20px">
          Confirmez que cette adresse vous appartient pour terminer l'opération.
        </mj-text>

        <mj-button href="${escapeHtml(confirmationUrl)}" padding="10px 0">
          ${actionLabel}
        </mj-button>

        <mj-text padding-top="20px" font-size="12px" color="#666666">
          Ce lien est utilisable une seule fois et expire le ${escapeHtml(formatEmailVerificationExpiration(expiresAt))}.
        </mj-text>

        <mj-text font-size="12px" color="#666666">
          Si vous n'avez pas demandé cette modification, ignorez cet email et vérifiez la sécurité de votre compte.
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
  `

  return renderMjml(mjmlTemplate)
}

export async function renderEmailVerificationRequestedAlertEmail({
  user,
  email,
  purpose,
  expiresAt
}) {
  const actionDescription = purpose === 'PRIMARY_CHANGE'
    ? `le remplacement de votre adresse de connexion par <strong>${escapeHtml(email)}</strong>`
    : `l'ajout de <strong>${escapeHtml(email)}</strong> comme autre adresse de connexion`

  const mjmlTemplate = `
<mjml>
  <mj-head>
    <mj-title>Modification de vos adresses de connexion - Partageons l'eau</mj-title>
    <mj-attributes>
      <mj-all font-family="Arial, sans-serif" />
      <mj-text font-size="14px" color="#333333" line-height="1.6" />
    </mj-attributes>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <mj-section background-color="#ffffff" padding="40px 20px">
      <mj-column>
        <mj-text font-size="24px" font-weight="bold" align="center" padding-bottom="20px">
          Partageons l'Eau
        </mj-text>

        <mj-text padding-bottom="20px">
          Bonjour ${escapeHtml(getDisplayName(user))},
        </mj-text>

        <mj-text padding-bottom="20px">
          Une demande concernant ${actionDescription} vient d'être enregistrée sur votre compte.
        </mj-text>

        <mj-text padding-bottom="20px">
          Elle expirera le ${escapeHtml(formatEmailVerificationExpiration(expiresAt))} si la nouvelle adresse n'est pas confirmée.
        </mj-text>

        <mj-text font-size="12px" color="#666666">
          Si vous n'êtes pas à l'origine de cette demande, connectez-vous à votre compte pour l'annuler et changez votre mot de passe si vous en utilisez un.
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
  `

  return renderMjml(mjmlTemplate)
}

export async function renderPrimaryEmailChangedAlertEmail({
  user,
  previousEmail,
  newEmail
}) {
  const changeDescription = previousEmail
    ? `L'adresse de connexion <strong>${escapeHtml(previousEmail)}</strong> a été remplacée par <strong>${escapeHtml(newEmail)}</strong>.`
    : `L'adresse <strong>${escapeHtml(newEmail)}</strong> est désormais l'adresse principale de connexion à votre compte.`

  const mjmlTemplate = `
<mjml>
  <mj-head>
    <mj-title>Votre adresse de connexion a changé - Partageons l'eau</mj-title>
    <mj-attributes>
      <mj-all font-family="Arial, sans-serif" />
      <mj-text font-size="14px" color="#333333" line-height="1.6" />
    </mj-attributes>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <mj-section background-color="#ffffff" padding="40px 20px">
      <mj-column>
        <mj-text font-size="24px" font-weight="bold" align="center" padding-bottom="20px">
          Partageons l'Eau
        </mj-text>

        <mj-text padding-bottom="20px">
          Bonjour ${escapeHtml(getDisplayName(user))},
        </mj-text>

        <mj-text padding-bottom="20px">
          ${changeDescription}
        </mj-text>

        <mj-text padding-bottom="20px">
          Toutes les sessions ouvertes ont été fermées. Vous devez maintenant vous reconnecter avec la nouvelle adresse.
        </mj-text>

        <mj-text font-size="12px" color="#666666">
          Si vous n'êtes pas à l'origine de ce changement, contactez immédiatement l'équipe Partageons l'Eau.
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
  `

  return renderMjml(mjmlTemplate)
}
