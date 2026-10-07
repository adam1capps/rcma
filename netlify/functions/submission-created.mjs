// Runs on every verified submission to the "walkthrough" form (Netlify Forms).
// Sends two emails through SendGrid, from adam@re-dry.com:
//   A. Right away, to the assistant: the lead, and a drafted follow-up to the lead.
//   B. At 4:00 PM Central, to Adam: the same draft, for review. A lead that arrives
//      at or after 4:00 PM is scheduled for 8:00 AM the next day instead.
// Needs SENDGRID_API_KEY in the site's environment variables. Without it the
// function logs the lead and sends nothing.

// ---- Wording. Edit here. ---------------------------------------------------

const FORM_NAME = "walkthrough";
const FROM = { email: "adam@re-dry.com", name: "Adam Capps" };
const ASSISTANT = "assistant@re-dry.com";
const ADAM = "adam@re-dry.com";

const TIME_ZONE = "America/Chicago";
const REVIEW_HOUR = 16; // 4:00 PM
const ROLLOVER_HOUR = 8; // 8:00 AM next day, for leads at or after REVIEW_HOUR

const ASSISTANT_SUBJECT = (lead) => `New lead from the RCMA talk: ${lead.name}, ${lead.company}`;
const ASSISTANT_INTRO = "I have a lead and I need you to make sure I follow up with it.";

const REVIEW_SUBJECT = (lead) => `Review and send: follow-up to ${lead.name}, ${lead.company}`;
const REVIEW_INTRO = "Draft follow-up to this lead, for your review.";

const DRAFT_SUBJECT = "Walk-through of the McCallum High School job";
const DRAFT_BODY = (lead) => `Hi ${lead.name},

Thank you for asking about a walk-through of the McCallum High School job in Austin after my RCMA talk.

What days work for you? I will set it up.

Adam Capps
ReDry + Roof MRI
865.771.3848
adam@re-dry.com`;

// ---- Handler ---------------------------------------------------------------

export default async (req) => {
  let payload;
  try {
    ({ payload } = await req.json());
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!payload || payload.form_name !== FORM_NAME) {
    return new Response("ignored", { status: 200 });
  }

  const lead = pickLead(payload.data || {});
  const submitted = payload.created_at ? new Date(payload.created_at) : new Date();
  const key = process.env.SENDGRID_API_KEY;

  if (!key) {
    console.error("SENDGRID_API_KEY is not set. Lead not emailed:", JSON.stringify(lead));
    return new Response("no key", { status: 200 });
  }

  const details = leadDetails(lead, submitted);
  const draft = `Subject: ${DRAFT_SUBJECT}\n\n${DRAFT_BODY(lead)}`;

  const assistant = await sendMail(key, {
    to: ASSISTANT,
    subject: ASSISTANT_SUBJECT(lead),
    text: `${ASSISTANT_INTRO}\n\n${details}\n\nDraft follow-up for my review:\n\n${draft}\n`,
  });

  const review = await sendMail(key, {
    to: ADAM,
    subject: REVIEW_SUBJECT(lead),
    text: `${REVIEW_INTRO}\n\n${details}\n\n${draft}\n`,
    sendAt: reviewSendAt(submitted),
  });

  return new Response(JSON.stringify({ assistant, review }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

// ---- Helpers ---------------------------------------------------------------

function pickLead(data) {
  const clean = (v) => (typeof v === "string" && v.trim()) || "(not given)";
  return {
    name: clean(data.name),
    company: clean(data.company),
    email: clean(data.email),
    phone: clean(data.phone),
  };
}

function leadDetails(lead, submitted) {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(submitted);
  return [
    `Name: ${lead.name}`,
    `Company: ${lead.company}`,
    `Email: ${lead.email}`,
    `Phone: ${lead.phone}`,
    `Submitted: ${when}`,
    "Form: Walk-through request, rcma2026.re-dry.com/walkthrough/",
  ].join("\n");
}

async function sendMail(key, { to, subject, text, sendAt }) {
  const body = {
    personalizations: [{ to: [{ email: to }] }],
    from: FROM,
    reply_to: { email: ADAM, name: FROM.name },
    subject,
    content: [{ type: "text/plain", value: text }],
  };
  if (sendAt) body.send_at = sendAt;

  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`SendGrid ${res.status} sending to ${to}: ${detail}`);
      return { to, ok: false, status: res.status };
    }
    return { to, ok: true, status: res.status, sendAt: sendAt || null };
  } catch (err) {
    console.error(`SendGrid request failed sending to ${to}:`, err);
    return { to, ok: false, error: String(err) };
  }
}

// Wall-clock parts of an instant in TIME_ZONE.
function zoneParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

// TIME_ZONE's UTC offset (ms) at the given instant.
function zoneOffsetMs(date) {
  const p = zoneParts(date);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - date.getTime();
}

// The instant when TIME_ZONE reads y-m-d h:00. Two passes handle DST changes.
function zonedToUtc(y, m, d, h) {
  const guess = Date.UTC(y, m - 1, d, h, 0, 0);
  const first = guess - zoneOffsetMs(new Date(guess));
  const second = guess - zoneOffsetMs(new Date(first));
  return new Date(second);
}

// Unix seconds for Email B: 4:00 PM the same Central day, or 8:00 AM the next.
export function reviewSendAt(submitted) {
  const p = zoneParts(submitted);
  let target;
  if (p.h < REVIEW_HOUR) {
    target = zonedToUtc(p.y, p.m, p.d, REVIEW_HOUR);
  } else {
    const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
    target = zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), ROLLOVER_HOUR);
  }
  return Math.floor(target.getTime() / 1000);
}
