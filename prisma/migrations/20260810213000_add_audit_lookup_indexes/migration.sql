CREATE INDEX "AuditEvent_targetId_occurredAt_idx"
ON "AuditEvent"("targetId", "occurredAt");

CREATE INDEX "AuditMutation_entityId_occurredAt_idx"
ON "AuditMutation"("entityId", "occurredAt" DESC);

CREATE INDEX "AuditMutationScope_resourceId_occurredAt_idx"
ON "AuditMutationScope"("resourceId", "occurredAt" DESC);

CREATE INDEX "AuditMutationScope_resourceLabel_trgm_idx"
ON "AuditMutationScope" USING GIN ("resourceLabel" gin_trgm_ops);
