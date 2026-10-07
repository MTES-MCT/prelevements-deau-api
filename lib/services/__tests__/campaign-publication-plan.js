import test from 'ava'
import {campaignPublicationCoverage, campaignReadingsMatch, CAMPAIGN_VOLUME_BOUNDARIES} from '../campaign-publication-plan.js'

const [start, middle, end] = CAMPAIGN_VOLUME_BOUNDARIES
const publication = (periodStart, periodEnd) => ({periodStart, periodEnd})

test('physical coverage requires complete non-overlapping intervals at both calendar boundaries', t => {
  const inside = new Date('2026-02-01T23:00:00Z')
  t.true(campaignPublicationCoverage([publication(start, inside), publication(inside, middle), publication(middle, end)]))
  t.false(campaignPublicationCoverage([publication(start, middle)]))
  t.false(campaignPublicationCoverage([publication(start, end)]))
  t.false(campaignPublicationCoverage([publication(start, middle), publication(start, middle), publication(middle, end)]))
  t.false(campaignPublicationCoverage([publication(start, inside), publication(middle, end)]))
  t.false(campaignPublicationCoverage([publication(new Date(start.getTime() - 1), middle), publication(middle, end)]))
})

test('supplier matching requires each exact admissible boundary and compares exact decimals', t => {
  const meter = {offSeason: {indexStart: '100', indexEnd: '200'}, season: {indexEnd: '260'}}
  const readings = CAMPAIGN_VOLUME_BOUNDARIES.map((observedAt, index) => ({observedAt,
    currentRevision: {admissible: true, index: ['100.0000', '200.0000', '260.0000'][index]}}))
  t.true(campaignReadingsMatch(meter, readings))
  t.false(campaignReadingsMatch(meter, readings.slice(0, 2)))
  t.false(campaignReadingsMatch(meter, readings.map((reading, index) => index === 1
    ? {...reading, currentRevision: {admissible: false, index: '200'}} : reading)))
  t.false(campaignReadingsMatch(meter, readings.map((reading, index) => index === 1
    ? {...reading, currentRevision: {admissible: true, index: '200.0001'}} : reading)))
})
