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
