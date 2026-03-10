import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import jsforce from "jsforce";
import jwt from "jsonwebtoken";
import express from "express";
import crypto from "crypto";
import { z } from "zod";

const app = express();

// Get Salesforce connection using JWT
async function getSalesforceConnection() {
  const privateKey = Buffer.from(
    process.env.SF_PRIVATE_KEY_BASE64,
    "base64"
  ).toString("utf-8");

  const loginUrl = process.env.SF_LOGIN_URL || "https://login.salesforce.com";

  const token = jwt.sign(
    {
      iss: process.env.SF_CLIENT_ID,
      sub: process.env.SF_USERNAME,
      aud: loginUrl,
      exp: Math.floor(Date.now() / 1000) + 300,
    },
    privateKey,
    { algorithm: "RS256" }
  );

  // Get access token via JWT bearer flow
  const tokenResponse = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: token,
    }),
  });

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok) {
    throw new Error(`Salesforce auth failed: ${tokenData.error} - ${tokenData.error_description}`);
  }

  // Create connection with access token
  const conn = new jsforce.Connection({
    instanceUrl: tokenData.instance_url,
    accessToken: tokenData.access_token,
  });

  return conn;
}

// Create MCP Server
const server = new McpServer({
  name: "salesforce-mcp-server",
  version: "1.0.0",
});

// Register tools

// Helper function to generate phone search patterns
function generatePhonePatterns(phone) {
  // Strip to digits only
  const digits = phone.replace(/\D/g, "");

  const patterns = new Set();

  // Add original input
  patterns.add(phone);

  // Add digits only
  patterns.add(digits);

  // If 10+ digits, try common US formats
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    const area = last10.slice(0, 3);
    const prefix = last10.slice(3, 6);
    const line = last10.slice(6, 10);

    // Various formats
    patterns.add(`${area}-${prefix}-${line}`);           // 239-290-1984
    patterns.add(`(${area}) ${prefix}-${line}`);         // (239) 290-1984
    patterns.add(`${area}.${prefix}.${line}`);           // 239.290.1984
    patterns.add(`${area}${prefix}${line}`);             // 2392901984
    patterns.add(`1${area}${prefix}${line}`);            // 12392901984
    patterns.add(`+1${area}${prefix}${line}`);           // +12392901984
    patterns.add(`+1-${area}-${prefix}-${line}`);        // +1-239-290-1984

    // Also search for just last 7 digits (without area code)
    patterns.add(`${prefix}-${line}`);
    patterns.add(`${prefix}${line}`);
  }

  // If 7 digits, try formats without area code
  if (digits.length === 7) {
    const prefix = digits.slice(0, 3);
    const line = digits.slice(3, 7);
    patterns.add(`${prefix}-${line}`);
    patterns.add(`${prefix}.${line}`);
  }

  return Array.from(patterns);
}

// Tool 1: Search for contacts by phone
server.tool(
  "hackstart_search_contacts",
  "Search for existing contacts in Salesforce by phone number. Use this FIRST when a customer texts in to check if they already exist in the system. Returns contact ID, name, and phone. If no results found, use create_contact to add them. Handles any phone format (with or without dashes, parentheses, etc.).",
  {
    phone: z.string().describe("Customer's phone number in any format (e.g., '239-290-1984', '2392901984', '(239) 290-1984'). The search will automatically try multiple formats to find matches."),
  },
  async ({ phone }) => {
    try {
      const conn = await getSalesforceConnection();
      const patterns = generatePhonePatterns(phone);

      // Build OR conditions for all patterns
      const conditions = patterns.map(p => `Phone LIKE '%${p}%'`).join(" OR ");
      const query = `SELECT Id, FirstName, LastName, Phone FROM Contact WHERE ${conditions} LIMIT 10`;

      const result = await conn.query(query);

      // Deduplicate by Id
      const uniqueRecords = Array.from(
        new Map(result.records.map(r => [r.Id, r])).values()
      );

      return {
        content: [{ type: "text", text: JSON.stringify(uniqueRecords, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 2: Create a new contact
server.tool(
  "hackstart_create_contact",
  "Create a new contact in Salesforce CRM. Use this when search_contacts returns no results for a new customer. Returns the new contactId which is required for create_appointment and create_sms_log.",
  {
    firstName: z.string().describe("Customer's first name (e.g., 'John')."),
    lastName: z.string().describe("Customer's last name (e.g., 'Smith')."),
    phone: z.string().describe("Customer's phone number with country code (e.g., '+15551234567' or '5551234567')."),
  },
  async ({ firstName, lastName, phone }) => {
    try {
      const conn = await getSalesforceConnection();
      const result = await conn.sobject("Contact").create({
        FirstName: firstName,
        LastName: lastName,
        Phone: phone,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ success: result.success, contactId: result.id }, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 3: Search for leads by phone
server.tool(
  "hackstart_search_leads",
  "Search for existing leads in Salesforce by phone number. Leads are potential customers who haven't been qualified yet. Use this to check if an inbound contact is already a lead before creating a new one. Returns lead ID, name, company, phone, and status. Handles any phone format (with or without dashes, parentheses, etc.).",
  {
    phone: z.string().describe("Lead's phone number in any format (e.g., '239-290-1984', '2392901984', '(239) 290-1984'). The search will automatically try multiple formats to find matches."),
  },
  async ({ phone }) => {
    try {
      const conn = await getSalesforceConnection();
      const patterns = generatePhonePatterns(phone);

      // Build OR conditions for all patterns
      const conditions = patterns.map(p => `Phone LIKE '%${p}%'`).join(" OR ");
      const query = `SELECT Id, FirstName, LastName, Company, Phone, Email, Status, LeadSource FROM Lead WHERE ${conditions} LIMIT 10`;

      const result = await conn.query(query);

      // Deduplicate by Id
      const uniqueRecords = Array.from(
        new Map(result.records.map(r => [r.Id, r])).values()
      );

      return {
        content: [{ type: "text", text: JSON.stringify(uniqueRecords, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 4: Create a new lead
server.tool(
  "hackstart_create_lead",
  "Create a new lead in Salesforce. Leads represent potential customers at the top of the sales funnel. Use this instead of create_contact when the person hasn't been qualified yet. Returns the new leadId for use with create_sms_log. Lead source is automatically set to 'SMS'.",
  {
    firstName: z.string().describe("Lead's first name (e.g., 'John')."),
    lastName: z.string().describe("Lead's last name (e.g., 'Smith'). Required."),
    phone: z.string().describe("Lead's phone number (e.g., '+15551234567')."),
    company: z.string().optional().describe("Company or business name (optional, e.g., 'Acme Corp'). Defaults to 'Individual' if not provided."),
    email: z.string().optional().describe("Lead's email address (optional)."),
    status: z.string().optional().describe("Lead status. Options: 'Open - Not Contacted', 'Working - Contacted', 'Closed - Converted', 'Closed - Not Converted'. Default: 'Open - Not Contacted'."),
  },
  async ({ firstName, lastName, phone, company, email, status }) => {
    try {
      const conn = await getSalesforceConnection();
      const leadData = {
        FirstName: firstName,
        LastName: lastName,
        Company: company || "Individual",
        Phone: phone,
        LeadSource: "SMS",
      };

      if (email) leadData.Email = email;
      if (status) leadData.Status = status;

      const result = await conn.sobject("Lead").create(leadData);
      return {
        content: [{ type: "text", text: JSON.stringify({ success: result.success, leadId: result.id }, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 5: Update Contact with SMS conversation summary
server.tool(
  "hackstart_create_sms_log",
  "Save SMS conversation summary directly to the Contact record in Salesforce. Call this AFTER every customer conversation ends. Updates the Contact's 'Invoca Call Summary' field with the conversation details.",
  {
    contactId: z.string().describe("The Salesforce Contact ID (starts with '003'). Get this from search_contacts or create_contact response."),
    conversationSummary: z.string().describe("Complete summary of the SMS conversation. Include: customer intent, what was discussed, any appointments booked, commitments made, and next steps."),
  },
  async ({ contactId, conversationSummary }) => {
    try {
      const conn = await getSalesforceConnection();

      const result = await conn.sobject("Contact").update({
        Id: contactId,
        Invoca_Call_Summary__c: conversationSummary,
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ success: result.success, contactId: contactId }, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 6: Create appointment (Event)
server.tool(
  "hackstart_create_appointment",
  "Book an appointment in Salesforce calendar as an Event. Use this when customer confirms a specific time slot. IMPORTANT: Always call get_available_slots first to verify the slot is available before booking.",
  {
    contactId: z.string().describe("The Salesforce Contact ID or Lead ID (starts with '003' for contacts or '00Q' for leads). Get this from search_contacts, create_contact, search_leads, or create_lead response."),
    subject: z.string().describe("Appointment title shown on calendar (e.g., 'Sales Consultation', 'Product Demo', 'Service Appointment')."),
    startDateTime: z.string().describe("Appointment start time in ISO format. Must be in UTC (e.g., '2026-01-25T14:00:00Z' for 9am Eastern)."),
    endDateTime: z.string().describe("Appointment end time in ISO format. Typically 30 minutes after start (e.g., '2026-01-25T14:30:00Z')."),
  },
  async ({ contactId, subject, startDateTime, endDateTime }) => {
    try {
      const conn = await getSalesforceConnection();
      const result = await conn.sobject("Event").create({
        Subject: subject,
        StartDateTime: startDateTime,
        EndDateTime: endDateTime,
        WhoId: contactId,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ success: result.success, appointmentId: result.id }, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 7: Get available appointment slots for a specific date
server.tool(
  "hackstart_get_available_slots",
  "Check available appointment times for a specific date. Call this BEFORE offering appointment times to customers or booking appointments. Returns available 30-minute slots not already booked. Business hours: Monday-Friday 9am-10pm Eastern. Closed weekends.",
  {
    date: z.string().describe("Date to check in YYYY-MM-DD format (e.g., '2026-01-25'). Must be a weekday (Monday-Friday). Returns empty for weekends."),
  },
  async ({ date }) => {
    try {
      const conn = await getSalesforceConnection();

      // Business hours config (Eastern timezone)
      const BUSINESS_START_HOUR = 9; // 9am
      const BUSINESS_END_HOUR = 22; // 10pm
      const SLOT_DURATION_MINUTES = 30;
      const TIMEZONE = "America/New_York";

      // Parse the requested date
      const requestedDate = new Date(date + "T00:00:00");
      const dayOfWeek = requestedDate.getDay();

      // Check if it's a weekend (0 = Sunday, 6 = Saturday)
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            available: false,
            message: "We are closed on weekends. Business hours are Monday-Friday 9am-10pm Eastern.",
            availableSlots: []
          }, null, 2) }],
        };
      }

      // Generate all possible 30-min slots for the day (9am to 10pm = 9:00 to 21:30 last slot)
      const allSlots = [];
      for (let hour = BUSINESS_START_HOUR; hour < BUSINESS_END_HOUR; hour++) {
        for (let min = 0; min < 60; min += SLOT_DURATION_MINUTES) {
          // Last slot should end by 10pm, so last start time is 9:30pm
          if (hour === BUSINESS_END_HOUR - 1 && min > 30) continue;
          if (hour === BUSINESS_END_HOUR) continue;

          const slotStart = `${hour.toString().padStart(2, "0")}:${min.toString().padStart(2, "0")}`;
          allSlots.push(slotStart);
        }
      }

      // Query existing appointments for this date from Salesforce
      const startOfDay = `${date}T00:00:00.000Z`;
      const endOfDay = `${date}T23:59:59.000Z`;

      const query = `SELECT Id, StartDateTime, EndDateTime FROM Event WHERE StartDateTime >= ${startOfDay} AND StartDateTime <= ${endOfDay}`;
      const result = await conn.query(query);

      // Extract booked time slots
      const bookedSlots = new Set();
      result.records.forEach((event) => {
        const start = new Date(event.StartDateTime);
        const end = new Date(event.EndDateTime);

        // Mark all 30-min slots that overlap with this event as booked
        let current = new Date(start);
        while (current < end) {
          const hours = current.getUTCHours();
          const minutes = current.getUTCMinutes();
          // Adjust for Eastern time (UTC-5 or UTC-4 depending on DST)
          const slotKey = `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
          bookedSlots.add(slotKey);
          current.setMinutes(current.getMinutes() + SLOT_DURATION_MINUTES);
        }
      });

      // Filter out booked slots
      const availableSlots = allSlots.filter((slot) => !bookedSlots.has(slot));

      // Format slots nicely for display (convert to 12-hour format)
      const formattedSlots = availableSlots.map((slot) => {
        const [hour, min] = slot.split(":").map(Number);
        const period = hour >= 12 ? "PM" : "AM";
        const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
        return `${displayHour}:${min.toString().padStart(2, "0")} ${period}`;
      });

      return {
        content: [{ type: "text", text: JSON.stringify({
          date: date,
          timezone: "Eastern",
          businessHours: "9:00 AM - 10:00 PM",
          slotDuration: "30 minutes",
          availableSlots: formattedSlots,
          totalAvailable: formattedSlots.length
        }, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 8: Create a new account
server.tool(
  "hackstart_create_account",
  "Create a business/company account in Salesforce. Use for B2B customers when tracking a company separately from individual contacts. Optional - most SMS conversations only need contacts.",
  {
    name: z.string().describe("Company or business name (e.g., 'Acme Corporation'). This is the only required field."),
    phone: z.string().optional().describe("Company main phone number (optional)."),
    website: z.string().optional().describe("Company website (optional, e.g., 'https://acme.com')."),
    industry: z.string().optional().describe("Industry category (optional). Examples: 'Technology', 'Healthcare', 'Finance', 'Retail', 'Manufacturing'."),
    description: z.string().optional().describe("Notes about the company (optional)."),
  },
  async ({ name, phone, website, industry, description }) => {
    try {
      const conn = await getSalesforceConnection();
      const accountData = { Name: name };

      if (phone) accountData.Phone = phone;
      if (website) accountData.Website = website;
      if (industry) accountData.Industry = industry;
      if (description) accountData.Description = description;

      const result = await conn.sobject("Account").create(accountData);
      return {
        content: [{ type: "text", text: JSON.stringify({ success: result.success, accountId: result.id }, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 9: Schedule CTA (Mock)
server.tool(
  "schedule_cta",
  `Manage Call-To-Action (CTA) reminder messages for scheduled callbacks. Handles the full lifecycle: scheduling new reminders, cancelling, rescheduling, and checking status. Only ONE CTA can be scheduled per conversation at a time.

PREREQUISITE - NAME REQUIRED (HARD BLOCK):
STOP. Before calling this tool with action "schedule" or "reschedule", ask yourself: "Did the customer tell me their name in this conversation?"
- Scan the ENTIRE conversation history for a name.
- If NO name was provided: You MUST ask "Before we book that, may I get your name?" and WAIT for their response.
- DO NOT call this tool until you have their name. No exceptions.

PREREQUISITE - DATE & TIME RESOLUTION (MANDATORY):
YOU DO NOT KNOW THE CURRENT DATE. Your training data is outdated. You MUST call current_date_time to get the real date BEFORE calling this tool.
- CALL current_date_time IMMEDIATELY when the user mentions scheduling, booking, appointments, or ANY date reference (tomorrow, Friday, next week, etc.).
- USE the year from the tool response (NOT 2023/2024/2025). NEVER guess the year.
- Calculate the date based on user input, then VERIFY the day-of-week matches.

APPOINTMENT BOOKING FLOW (follow these steps in exact order):
Step 0 (Name Check - MANDATORY): Verify you have the customer's name. If not, ask for it and STOP. Do NOT proceed.
Step 1 (Identify): User indicates intent to book/schedule.
Step 2 (Get Current Date - MANDATORY): ALWAYS call current_date_time FIRST. Do not skip this step.
Step 3 (Calculate): Using the ACTUAL current date from current_date_time, calculate the specific date. Verify the day-of-week is correct.
Step 4 (Validate): Call business_hours_checker with businessHours and userTime (including customer's timezone). Accept whatever timezone the customer provides and clean it into: state name (e.g., "Florida"), abbreviation (e.g., "EST"), timezone name (e.g., "Eastern"), or IANA (e.g., "America/New_York"). NEVER ask the customer to reformat their timezone. If withinBusinessHours=false, tell the customer and ask for another time.
Step 5 (Book): If withinBusinessHours=true, call this tool with action "schedule". Copy the sendAt value from business_hours_checker response EXACTLY. Do NOT modify it. Do NOT recalculate it. The tool already computed the correct time (5 minutes before), correct date, and correct timezone offset including DST.

AFTER BOOKING - WHAT TO TELL THE CUSTOMER:
Say: "You're set for [date] at [time]. About five minutes before, you'll receive a priority phone number to call and connect with a specialist."
If customer asks "who will contact me" or implies they expect us to reach out, IMMEDIATELY clarify: "Just to clarify—you'll call us using the priority number we send. That connects you straight to a specialist, no hold time."

NEGATIVE CONSTRAINTS (NEVER do these):
- NEVER say "reminder" when referring to the CTA
- NEVER say "we will call you", "our specialist will dial you", "we'll reach out", or "someone will contact you"
- We do NOT make outbound calls. The customer must call us.
- NEVER fabricate a sendAt value — it must come from business_hours_checker
- NEVER schedule without confirming the customer's name first`,
  {
    action: z.enum(["schedule", "cancel", "reschedule", "list"]).describe(
      `The CTA lifecycle action to perform:
- "schedule": Create a new CTA reminder. Requires sendAt. If a CTA already exists, it will be automatically rescheduled.
- "cancel": Permanently cancel the current scheduled CTA. The message will NOT be sent. Use when customer says "cancel", "never mind", "don't text me".
- "reschedule": Change the send time of the current CTA. Requires new sendAt. Use when customer says "make it 4pm instead", "push it back an hour".
- "list": Check if there's a currently scheduled CTA and its details.`
    ),
    sendAt: z.string().optional().describe(
      "ISO8601 datetime for when the CTA should fire (requested callback time minus 5 minutes). Required for 'schedule' and 'reschedule' actions. MUST be copied EXACTLY from business_hours_checker output — do NOT fabricate or recalculate this value. Example: '2026-03-11T14:55:00-04:00'"
    ),
  },
  async ({ action, sendAt }) => {
    const mockResponses = {
      schedule: { success: true, action: "scheduled", messageId: "mock-msg-" + Date.now(), sendAt: sendAt || null, message: "CTA scheduled successfully" },
      cancel: { success: true, action: "cancelled", message: "CTA has been cancelled and will not be sent" },
      reschedule: { success: true, action: "rescheduled", messageId: "mock-msg-" + Date.now(), sendAt: sendAt || null, message: "CTA rescheduled successfully" },
      list: { success: true, action: "list", activeCTA: null, message: "No active CTA found" },
    };
    return {
      content: [{ type: "text", text: JSON.stringify(mockResponses[action] || { success: false, error: "Unknown action" }, null, 2) }],
    };
  }
);

// Tool 10: Post Consumer Profile (Mock)
server.tool(
  "post_consumer_profile",
  `Updates the consumer profile with the user's name and phone number.

WHEN TO CALL (TRIGGER): Call this tool IMMEDIATELY as soon as the user provides their name during the conversation. Do not delay — this is a high-priority action.

CALL ONLY ONCE PER SESSION: Before calling, review chat history to check if you have already called this tool in this session.
- If already called with the same data: Do NOT call again.
- If the user provides UPDATED information (e.g., corrects their name or gives a different phone number): Call again with the new data.
- Constraint: Only call once per session unless data changes.

INPUT VALUES:
- consumer_phone_number: Use the variable {consumer_phone_number} from the conversation context. Must be in E.164 format (e.g., "+15551234567"). Required.
- consumer_name: The name extracted from the user's input (e.g., "John Smith"). Required.
- conversation_id: Use the variable {conversation_id} from the conversation context. Required.
- tenant_gid: Use the variable {tenant_gid} from the conversation context. Required.`,
  {
    consumer_phone_number: z.string().describe("Phone number of consumer in E.164 format (e.g., '+15551234567'). Source from {consumer_phone_number} context variable."),
    consumer_name: z.string().describe("Consumer's full name as they provided it (e.g., 'John Smith')."),
    conversation_id: z.string().describe("The current conversation/session ID. Source from {conversation_id} context variable."),
    tenant_gid: z.string().describe("The tenant/account GID. Source from {tenant_gid} context variable."),
  },
  async ({ consumer_phone_number, consumer_name, conversation_id, tenant_gid }) => {
    return {
      content: [{ type: "text", text: JSON.stringify({
        success: true,
        consumer_phone_number,
        consumer_name,
        conversation_id,
        tenant_gid,
        message: "Consumer profile updated successfully"
      }, null, 2) }],
    };
  }
);

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Store transports by session ID
const transports = new Map();

// MCP endpoint - handles all MCP requests
app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] || crypto.randomUUID();

    let transport = transports.get(sessionId);
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
      });
      transports.set(sessionId, transport);
      await server.connect(transport);
    }

    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("MCP Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Handle GET for SSE streams
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = transports.get(sessionId);

  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

// Handle DELETE for session cleanup
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = transports.get(sessionId);

  if (transport) {
    await transport.handleRequest(req, res);
    transports.delete(sessionId);
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Salesforce MCP Server running on http://localhost:${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
