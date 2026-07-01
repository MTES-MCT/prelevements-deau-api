import mjml2html from 'mjml'

function getDisplayName(user) {
  return [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || user?.email || 'utilisateur'
}

function renderMjml(mjmlTemplate) {
  const {html, errors} = mjml2html(mjmlTemplate, {
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

export function renderMagicLinkEmail(user, authToken, apiUrl) {
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

export function renderDeclarationPointsChangeRequestEmail({
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

export function renderDeclarationReminderEmail(user, appUrl) {
  const mjmlTemplate = `
<mjml>
  <mj-head>
    <mj-title>Suivi de déclaration - Partageons l'eau</mj-title>
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
          Nous n'avons pas reçu de déclaration récente de votre part.
        </mj-text>

        <mj-text padding-bottom="20px">
          Nous vous invitons à vous connecter à l'application afin de compléter votre déclaration si nécessaire.
        </mj-text>

        <mj-button href="${appUrl}" padding="10px 0">
          Accéder à mon espace
        </mj-button>

        <mj-text padding-top="20px" font-size="12px" color="#666666">
          Si votre situation est déjà à jour, vous pouvez ignorer ce message.
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
  `

  return renderMjml(mjmlTemplate)
}

export function renderAccountCreationEmail(user, appUrl) {
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

export function renderZoneAttachmentEmail(user, zone, appUrl) {
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
