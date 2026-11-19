/** Shared domain vocabulary. Labels use approved Islamic banking terminology. */
export const FACILITY_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  IN_REVIEW: 'Under Review',
  RETURNED: 'Returned for Rework',
  APPROVED: 'Approved',
  DECLINED: 'Declined',
  WITHDRAWN: 'Withdrawn',
  OFFER_ISSUED: 'Offer Issued',
  IN_NEGOTIATION: 'Under Negotiation',
  OFFER_ACCEPTED: 'Offer Accepted',
  OFFER_REJECTED: 'Offer Rejected',
  FULFILMENT: 'Documentation & Conditions',
  READY_FOR_ACTIVATION: 'Ready for Activation',
  ACTIVE: 'Active',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};

export const DOCUMENT_STATUS_LABEL: Record<string, string> = {
  REQUIRED: 'Required',
  UPLOADED: 'Uploaded',
  UNDER_REVIEW: 'Under Review',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
  SUPERSEDED: 'Superseded',
};

export const APPLICATION_STEPS = [
  { key: 'PRODUCT', label: 'Product' },
  { key: 'DETAILS', label: 'Facility details' },
  { key: 'PRODUCT_INFO', label: 'Product information' },
  { key: 'SECURITY', label: 'Security' },
  { key: 'FINANCIALS', label: 'Financial statements' },
  { key: 'BANK_STATEMENTS', label: 'Bank statements' },
  { key: 'DOCUMENTS', label: 'Documents' },
  { key: 'REVIEW', label: 'Review & submit' },
] as const;
export type ApplicationStep = (typeof APPLICATION_STEPS)[number]['key'];

export const WORKFLOW_ACTION_LABEL: Record<string, string> = {
  APPROVE: 'Approve',
  RECOMMEND: 'Recommend',
  DECLINE: 'Decline',
  RETURN: 'Return for Rework',
  REQUEST_CLARIFICATION: 'Request Clarification',
  COMMENT: 'Comment',
  VOTE: 'Vote',
  COMPLETE: 'Complete',
};

export const ROLE_LABEL: Record<string, string> = {
  RM: 'Relationship Manager', BM: 'Business Manager', RBE: 'Regional Business Executive', DH: 'Directorate Head',
  CREDIT_ANALYST: 'Credit Analyst', ES_ANALYST: 'E&S Analyst', CREDIT_TEAM_LEAD: 'Credit Team Lead', GH_CREDIT_RISK: 'Group Head, Credit Risk',
  CRO: 'Chief Risk Officer', ED: 'Executive Director', MD: 'Managing Director', MIC_MEMBER: 'MIC member', BCC_MEMBER: 'BCC member', BOARD_MEMBER: 'Board member',
  LEGAL: 'Legal', SHARIAH: 'Shariah Compliance', CREDIT_OPS: 'Credit Operations', ADMIN: 'Administrator', SUPER_ADMIN: 'Super Administrator', AUDITOR: 'Internal Audit',
};
