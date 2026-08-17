// Exceptions auditées dans VigiEau pour le snapshot SANDRE du 13 août 2026.
// Le hash couvre la géométrie brute et toutes les métadonnées : au moindre
// changement amont, la réparation repasse sous le seuil strict global.
const APPROVALS = [
  {
    codeSandre: '3575',
    gid: 3575,
    payloadHash: '22cf08f853d00b25d6c0f9d427acecd37962609935154ef3ff8313cd0a208945',
    maxRelativeAreaDelta: 3.6e-9
  },
  {
    codeSandre: '3579',
    gid: 3579,
    payloadHash: '7f232eebd178cd4f6b2ec702fee1ebc331972130af120c2c94c5e8a01c560d80',
    maxRelativeAreaDelta: 2.4e-9
  },
  {
    codeSandre: '3586',
    gid: 3586,
    payloadHash: '35be0a1f63605be5c3c42d9156cca30715e3c3824644ba0c08e0de2827414b91',
    maxRelativeAreaDelta: 7.8e-9
  },
  {
    codeSandre: '3592',
    gid: 3592,
    payloadHash: '214da0f5d4a00a4c665c6673f6876b5340a63b5c9fa93e3731bcfc57c4484ac5',
    maxRelativeAreaDelta: 6e-9
  },
  {
    codeSandre: '3951',
    gid: 3951,
    payloadHash: 'b616b948eb371730a69609004934e3427273c6f6e6ba0a87a3121d016e76caeb',
    maxRelativeAreaDelta: 2.2e-9
  },
  {
    codeSandre: '3956',
    gid: 3956,
    payloadHash: 'f5f579f9d779bbbcaf3a2a265396b9384131439a562bfeef6bc60e088a82b64b',
    maxRelativeAreaDelta: 4.6e-9
  },
  {
    codeSandre: '3958',
    gid: 3958,
    payloadHash: 'a8bf900285976fc3cb622139d3691b945d7659617107b8f1c72a42bd3369b05f',
    maxRelativeAreaDelta: 4.6e-8
  },
  {
    codeSandre: '3961',
    gid: 3961,
    payloadHash: '965630101723f894fa0bdae309999ec6bf8658e319fc329093d401924b312c37',
    maxRelativeAreaDelta: 9e-9
  }
]

export function getSandreGeometryRepairApproval(feature) {
  return APPROVALS.find(approval => (
    feature.departmentCode === '11'
    && feature.sourceUpdatedAt === '2026-08-13'
    && approval.codeSandre === feature.codeSandre
    && approval.gid === feature.gid
    && approval.payloadHash === feature.payloadHash
  )) ?? null
}
