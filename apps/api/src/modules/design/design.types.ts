export const DESIGN_KINDS = ['foundation', 'theme', 'component', 'layout', 'style_pack'] as const;
export type DesignKind = (typeof DESIGN_KINDS)[number];

export type JsonRecord = Record<string, unknown>;

export interface DomainPatch {
  schema: 'aurum.domain-patch.v1';
  operations: Array<{
    op: 'replace_document_content';
    documentKind: DesignKind;
    value: JsonRecord;
  }>;
}
