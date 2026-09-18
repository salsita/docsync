/**
 * A calendar that lives in memory, for the fetch tests.
 *
 * A person's calendar is private and cannot be a fixture (#38), so this
 * is what the adapter is tested against: a series, its instances, and the
 * attachments on each one. The attachments carry the ids of files in a fake
 * Drive (`../gdrive/fake-api.mock.ts`), so an attachment resolves to a real
 * conversion — a tabbed Doc included — rather than to a stub.
 */
import type { CalendarApi, CalendarEvent, EventAttachment, EventDateTime } from './api.js';

/** One instance of a series, or the single event a root can also name. */
export interface FakeInstance {
  /** Calendar spells an instance `<eventId>_<start>`; the fake may as well. */
  id?: string;
  summary?: string;
  start: EventDateTime;
  attachments?: EventAttachment[];
  /** `cancelled` for an occurrence someone deleted, which the API hides. */
  status?: string;
}

/** One event a root can name: a series with instances, or a single event. */
export interface FakeEvent {
  id: string;
  summary?: string;
  updated?: string;
  /** The calendar it lives on. Default: `primary`. */
  calendarId?: string;
  /** Present on a series, which is what makes `events.instances` the listing. */
  recurring?: boolean;
  instances: FakeInstance[];
}

export interface FakeCalendar extends CalendarApi {
  /** The events, by id, so a test can add an instance or an attachment. */
  events: Map<string, FakeEvent>;
  /** Every call, in order: `getEvent primary/ev1`, `instances primary/ev1`. */
  calls: string[];
}

/** A calendar holding the events given. */
export function createFakeCalendar(seed: readonly FakeEvent[] = []): FakeCalendar {
  const events = new Map(seed.map((one): [string, FakeEvent] => [one.id, one]));
  const calls: string[] = [];

  /** The event, or the 404 Calendar answers for an id it does not have. */
  function get(calendarId: string, eventId: string): FakeEvent {
    const found = events.get(eventId);
    if (found === undefined || (found.calendarId ?? 'primary') !== calendarId) {
      throw new Error(`Google API 404 on calendars/${calendarId}/events/${eventId}: Not Found`);
    }
    return found;
  }

  /** One instance as the API answers it: the series' own fields filled in. */
  function eventOf(event: FakeEvent, instance: FakeInstance): CalendarEvent {
    return {
      id: instance.id ?? event.id,
      summary: instance.summary ?? event.summary,
      start: instance.start,
      ...(event.updated === undefined ? {} : { updated: event.updated }),
      ...(instance.status === undefined ? {} : { status: instance.status }),
      ...(instance.attachments === undefined ? {} : { attachments: instance.attachments }),
      ...(event.recurring === true ? { recurringEventId: event.id } : {}),
    };
  }

  /** When an instance starts, as a number: the offsets differ between them. */
  function startsAt(instance: FakeInstance): number {
    const at = Date.parse(instance.start.dateTime ?? instance.start.date ?? '');
    return Number.isNaN(at) ? 0 : at;
  }

  return {
    events,
    calls,

    async getEvent(calendarId, eventId) {
      calls.push(`getEvent ${calendarId}/${eventId}`);
      const event = get(calendarId, eventId);
      const first = event.instances[0];
      return {
        id: event.id,
        ...(event.summary === undefined ? {} : { summary: event.summary }),
        ...(event.updated === undefined ? {} : { updated: event.updated }),
        ...(first === undefined ? {} : { start: first.start }),
        // A series is a series because it carries recurrence rules, which is
        // what the adapter reads to decide whether to list instances.
        ...(event.recurring === true ? { recurrence: ['RRULE:FREQ=WEEKLY'] } : {}),
        ...(event.recurring === true || first?.attachments === undefined
          ? {}
          : { attachments: first.attachments }),
      };
    },

    async instances(calendarId, eventId, options = {}) {
      calls.push(`instances ${calendarId}/${eventId}`);
      const event = get(calendarId, eventId);
      return (
        event.instances
          .filter((one) => one.status !== 'cancelled')
          // `timeMax` is exclusive on an instance's start: the future has no
          // notes, so it is never listed (MANUAL §7, #38).
          .filter(
            (one) => options.timeMax === undefined || startsAt(one) < Date.parse(options.timeMax),
          )
          .sort((a, b) => startsAt(a) - startsAt(b))
          .map((one) => eventOf(event, one))
      );
    },
  };
}
