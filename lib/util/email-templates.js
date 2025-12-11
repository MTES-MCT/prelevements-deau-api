import mjml2html from 'mjml'

export function renderMagicLinkEmail(user, authToken, apiUrl) {
  const mjmlTemplate = `
<mjml>
  <mj-head>
    <mj-title>Connexion à Prélèvements d'eau</mj-title>
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
          Prélèvements d'eau
        </mj-text>
        <mj-text padding-bottom="20px">
          Bonjour ${user.prenom} ${user.nom},
        </mj-text>
        <mj-text padding-bottom="20px">
          Vous avez demandé à vous connecter à l'application Prélèvements d'eau.
          Cliquez sur le lien correspondant au territoire auquel vous souhaitez accéder :
        </mj-text>
        ${user.roles.map(({territoire, role}) => `
        <mj-button href="${apiUrl}/auth/verify/${authToken}?territoire=${territoire}" padding="10px 0">
          ${territoire} (${role === 'editor' ? 'Éditeur' : 'Lecteur'})
        </mj-button>
        `).join('')}
        <mj-text padding-top="20px" font-size="12px" color="#666666">
          Ce lien est valable pendant 1 heure.
        </mj-text>
        <mj-text font-size="12px" color="#666666">
          Si vous n'avez pas demandé cette connexion, ignorez cet email.
        </mj-text>
      </mj-column>
    </mj-section>
    <mj-section background-color="#f4f4f4" padding="20px">
      <mj-column>
        <mj-text font-size="11px" color="#999999" align="center">
          Structure : ${user.structure || 'Non renseignée'}
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
  `

  const {html, errors} = mjml2html(mjmlTemplate, {
    validationLevel: 'soft'
  })

  if (errors && errors.length > 0) {
    console.warn('MJML warnings:', errors)
  }

  return html
}
