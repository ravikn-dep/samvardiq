/**
 * Internal contract for organization-scoped, non-clinical conversion events
 * (PRD "Healthcare Data Boundary"). This session defines the contract only —
 * no event is emitted to, or ingested from, any external analytics system.
 */
export type NonClinicalMarketingEventType =
  | 'gbp_interaction'
  | 'call_enquiry'
  | 'whatsapp_enquiry'
  | 'appointment_requested'
  | 'appointment_booked'
  | 'appointment_cancelled'
  | 'op_attended'
  | 'consultation_completed'
  | 'followup_completed'
  | 'review_requested'
  | 'review_received';

export interface NonClinicalMarketingEvent {
  type: NonClinicalMarketingEventType;
  organizationId: string;
  occurredAt: string;
  count?: number;
  metadata?: Record<string, string | number | boolean>;
}
