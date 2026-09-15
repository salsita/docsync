/**
 * The only part of the calendar adapter that talks to Google Calendar.
 *
 * Two methods of one endpoint (ticket 38): `events.get` reads the object a root
 * names, and `events.instances` lists the occurrences of a recurring one. That
 * is all a calendar root needs, because what it checks out is not the event but
 * the Drive files attached to it, and those are the Drive adapter's business.
 *
 * The types below spell the slice of Calendar v3 this adapter is written
 * against. They are deliberately partial, and every field is optional: an event
 * written by another client can leave any of them out.
 */
import { createGoogleHttp, GoogleApiError, type GoogleHttpOptions } from '../google-http.js';

export const CALENDAR_ENDPOINT = 'https://www.googleapis.com/calendar/v3';

/** One page of instances. Calendar's own default, and its cap is 2500. */
const PAGE_SIZE = 250;

/**
 * What a Google sign-in made before ticket 38 turns into: the stored token
 * carries the Drive and Docs scopes and not the Calendar one, and Google says
 * so with a 403. The message is the one thing to do about it (MANUAL §2).
 */
export const SCOPE_REFUSED =
  'The Google sign-in predates calendar support; run `docsync auth google` again.';

/** A time on an event: a stamp with an offset, or a date for an all-day event. */
export interface EventDateTime {
  /** `2026-09-01T09:00:00+02:00`. RFC 3339, always with an offset. */
  dateTime?: string;
  /** `2026-09-01`, for an all-day event, which has no time at all. */
  date?: string;
  /** The IANA zone the event is kept in, e.g. `Europe/Prague`. */
  timeZone?: string;
}

/** One file attached to an event. A Drive attachment carries a `fileId`. */
export interface EventAttachment {
  fileId?: string;
  fileUrl?: string;
  title?: string;
  mimeType?: string;
  iconLink?: string;
}

/** One event, or one instance of a recurring one. */
export interface CalendarEvent {
  id?: string;
  /** `confirmed`, `tentative` or `cancelled`; a cancelled instance is a hole. */
  status?: string;
  summary?: string;
  /** Last modification time of the event data, RFC 3339. */
  updated?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  /** RRULE lines. Present on a series and on nothing else. */
  recurrence?: string[];
  /** The series an instance belongs to. */
  recurringEventId?: string;
  originalStartTime?: EventDateTime;
  attachments?: EventAttachment[];
  htmlLink?: string;
}

/** What `events.instances` is asked for beyond the event itself. */
export interface InstanceOptions {
  /** Upper bound, exclusive, on an instance's start: the future has no notes. */
  timeMax?: string;
}

/** What `createCalendarApi` hands out. */
export interface CalendarApi {
  /** One event — a series, or an event that happens once — by its two ids. */
  getEvent(calendarId: string, eventId: string): Promise<CalendarEvent>;
  /**
   * Every occurrence of a recurring event, oldest first, across every page.
   * Cancelled instances are left out: Calendar keeps a deleted occurrence as a
   * hole in the series, and a hole has no attachments.
   */
  instances(
    calendarId: string,
    eventId: string,
    options?: InstanceOptions,
  ): Promise<CalendarEvent[]>;
}

export type CalendarApiOptions = GoogleHttpOptions;

/**
 * The API a real fetch talks to. `accessToken` is the *Google* token: the
 * Calendar scope is part of the Google sign-in, so there is no calendar
 * credential (MANUAL §2, ticket 38).
 */
export function createCalendarApi(
  accessToken: string,
  options: CalendarApiOptions = {},
): CalendarApi {
  const http = createGoogleHttp(accessToken, options);

  /** One request, with a scope refusal turned into the command to run. */
  async function json<T>(url: string): Promise<T> {
    try {
      return await http.json<T>(url);
    } catch (error) {
      if (isScopeRefusal(error)) throw new Error(SCOPE_REFUSED, { cause: error });
      throw error;
    }
  }

  /** `calendars/<calendarId>/events/<eventId>`, both ids escaped. */
  function eventPath(calendarId: string, eventId: string): string {
    return `${CALENDAR_ENDPOINT}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  }

  return {
    async getEvent(calendarId, eventId) {
      // One attendee is the fewest the API will report; docsync reads none of
      // them and a client call can have dozens.
      return json<CalendarEvent>(`${eventPath(calendarId, eventId)}?maxAttendees=1`);
    },

    async instances(calendarId, eventId, instanceOptions = {}) {
      const found: CalendarEvent[] = [];
      let pageToken: string | undefined;
      do {
        const query = new URLSearchParams({
          maxResults: String(PAGE_SIZE),
          maxAttendees: '1',
          // A cancelled occurrence is a hole in the series, not a call.
          showDeleted: 'false',
        });
        if (instanceOptions.timeMax !== undefined) query.set('timeMax', instanceOptions.timeMax);
        if (pageToken !== undefined) query.set('pageToken', pageToken);
        const page = await json<{ items?: CalendarEvent[]; nextPageToken?: string }>(
          `${eventPath(calendarId, eventId)}/instances?${query}`,
        );
        found.push(...(page.items ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined);
      return found.filter((one) => one.status !== 'cancelled');
    },
  };
}

/** Whether Google refused for want of a scope rather than for want of access. */
function isScopeRefusal(error: unknown): boolean {
  return (
    error instanceof GoogleApiError &&
    error.status === 403 &&
    /insufficient authentication scopes/i.test(error.detail)
  );
}
