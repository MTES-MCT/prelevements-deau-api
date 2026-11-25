import {receiptAccount, receiptName, resolveReceiptRecipient} from './declaration-receipt-recipient.js'

export async function recordDeclarationReceipt(client, {req, declaration, revision, kind, snapshot}) {
  const recipient = await resolveReceiptRecipient(client, req, declaration, revision)
  const beneficiary = await receiptAccount(client, declaration.declarantUserId)
  const declarantName = beneficiary?.declarant?.socialReason?.trim() || receiptName(beneficiary)
  await client.declarationReceipt.createMany({data: [{
    declarationId: declaration.id, revision, kind, ...recipient,
    ...(recipient.recipientEmail ? {} : {status: 'SKIPPED', failureCode: 'RECIPIENT_UNAVAILABLE'}),
    snapshot: {...snapshot, code: declaration.code, declarantName}
  }], skipDuplicates: true})
}
