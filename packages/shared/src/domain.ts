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
