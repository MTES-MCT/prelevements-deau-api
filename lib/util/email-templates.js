import mjml2html from 'mjml'

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
          Bonjour ${user.firstName} ${user.lastName},
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
