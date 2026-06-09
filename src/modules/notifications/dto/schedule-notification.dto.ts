import { CreateScheduledNotificationDto } from './create-scheduled-notification.dto';

/**
 * Action DTO for the "schedule notification" endpoint. Identical shape to
 * CreateScheduledNotificationDto — kept as a distinct type so the scheduling
 * action can evolve its own validation independently of the generic create.
 */
export class ScheduleNotificationDto extends CreateScheduledNotificationDto {}
