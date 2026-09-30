export const campaignSerialKey = value => String(value ?? '').trim().toLocaleUpperCase('fr')

// Absence is evidence for a source proposal, never permission to reuse a meter.
// Include deleted meters; only nonempty serials may be searched globally.
export async function findAbsentCampaignSerialNumbers(client, serialNumbers) {
  const queried = [...new Set(serialNumbers.map(campaignSerialKey).filter(Boolean))].sort()
  if (!queried.length) return []
  const matches = await client.compteur.findMany({
    where: {OR: queried.map(serialNumber => ({serialNumber: {equals: serialNumber, mode: 'insensitive'}}))},
    select: {serialNumber: true}
  })
  const existing = new Set(matches.map(meter => campaignSerialKey(meter.serialNumber)))
  return queried.filter(serialNumber => !existing.has(serialNumber))
}
