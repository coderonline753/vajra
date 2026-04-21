/**
 * Vajra Email Module
 * Built-in SMTP email sending. No nodemailer dependency.
 * Uses Bun's native TCP socket for SMTP protocol.
 *
 * @example
 *   const mailer = createMailer({ host: 'smtp.gmail.com', port: 587, user: 'me@gmail.com', pass: 'xxx' });
 *   await mailer.send({ to: 'user@example.com', subject: 'Hello', html: '<h1>Hi</h1>' });
 */

/* ═══════ TYPES ═══════ */

interface SMTPConfig {
  /** SMTP server hostname */
  host: string;
  /** SMTP port (587 for STARTTLS, 465 for SSL, 25 for plain) */
  port: number;
  /** SMTP username */
  user: string;
  /** SMTP password */
  pass: string;
  /** Use TLS (default: true for port 587/465) */
  secure?: boolean;
  /** From address (default: user) */
  from?: string;
  /** From name */
  fromName?: string;
  /** Connection timeout in ms (default: 10000) */
  timeout?: number;
}

interface EmailMessage {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  fromName?: string;
  replyTo?: string;
  cc?: string | string[];
  bcc?: string | string[];
  headers?: Record<string, string>;
}

interface SendResult {
  success: boolean;
  messageId: string;
  response?: string;
  error?: string;
}

/* ═══════ SMTP CLIENT ═══════ */

class SMTPClient {
  private config: Required<SMTPConfig>;

  constructor(config: SMTPConfig) {
    this.config = {
      host: config.host,
      port: config.port,
      user: config.user,
      pass: config.pass,
      secure: config.secure ?? (config.port === 465 || config.port === 587),
      from: config.from ?? config.user,
      fromName: config.fromName ?? '',
      timeout: config.timeout ?? 10000,
    };
  }

  async send(message: EmailMessage): Promise<SendResult> {
    const messageId = `<${crypto.randomUUID()}@${this.config.host}>`;
    const from = message.from || this.config.from;
    const fromName = message.fromName || this.config.fromName;
    const toList = Array.isArray(message.to) ? message.to : [message.to];
    const ccList = message.cc ? (Array.isArray(message.cc) ? message.cc : [message.cc]) : [];
    const bccList = message.bcc ? (Array.isArray(message.bcc) ? message.bcc : [message.bcc]) : [];

    // Build MIME message
    const boundary = `----vajra_${crypto.randomUUID().replace(/-/g, '')}`;
    const date = new Date().toUTCString();

    let headers = `From: ${fromName ? `"${fromName}" <${from}>` : from}\r\n`;
    headers += `To: ${toList.join(', ')}\r\n`;
    if (ccList.length > 0) headers += `Cc: ${ccList.join(', ')}\r\n`;
    headers += `Subject: ${encodeSubject(message.subject)}\r\n`;
    headers += `Date: ${date}\r\n`;
    headers += `Message-ID: ${messageId}\r\n`;
    headers += `MIME-Version: 1.0\r\n`;
    if (message.replyTo) headers += `Reply-To: ${message.replyTo}\r\n`;

    // Custom headers
    if (message.headers) {
      for (const [key, value] of Object.entries(message.headers)) {
        headers += `${key}: ${value}\r\n`;
      }
    }

    let body: string;
    if (message.html && message.text) {
      // Multipart alternative
      headers += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n`;
      body = `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${message.text}\r\n`;
      body += `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${message.html}\r\n`;
      body += `--${boundary}--\r\n`;
    } else if (message.html) {
      headers += `Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n`;
      body = message.html;
    } else {
      headers += `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n`;
      body = message.text || '';
    }

    const fullMessage = `${headers}\r\n${body}`;

    try {
      const response = await this.smtpSend(from, [...toList, ...ccList, ...bccList], fullMessage);
      return { success: true, messageId, response };
    } catch (err: any) {
      return { success: false, messageId, error: err.message };
    }
  }

  private async smtpSend(from: string, recipients: string[], message: string): Promise<string> {
    const { host, port, user, pass, timeout } = this.config;

    // Use Bun's native fetch with SMTP-like approach
    // For production: use net socket directly
    // Simplified: use Bun.spawn with a helper or built-in TCP

    // Since Bun doesn't have built-in SMTP socket API in a simple way,
    // we use the fetch-based approach for common SMTP relays (SES, Gmail, etc.)
    // that support HTTP API, or fall back to TCP socket

    return new Promise(async (resolve, reject) => {
      try {
        const socket = await Bun.connect({
          hostname: host,
          port,
          socket: {
            data(socket, data) {
              const response = new TextDecoder().decode(data);
              (socket.data as any).responses.push(response);
              (socket.data as any).resolve?.(response);
            },
            open(socket) {
              (socket.data as any).connected = true;
              (socket.data as any).resolve?.();
            },
            close() {},
            error(socket, err) {
              (socket.data as any).reject?.(err);
            },
            connectError(socket, err) {
              (socket.data as any).reject?.(err);
            },
          },
          data: { responses: [] as string[], resolve: null as any, reject: null as any, connected: false },
          tls: port === 465,
        });

        const waitForResponse = (): Promise<string> => {
          return new Promise((res, rej) => {
            (socket.data as any).resolve = res;
            (socket.data as any).reject = rej;
            setTimeout(() => rej(new Error('SMTP timeout')), timeout);
          });
        };

        const sendCommand = async (cmd: string): Promise<string> => {
          socket.write(cmd + '\r\n');
          return waitForResponse();
        };

        // Wait for server greeting
        await waitForResponse();

        // EHLO
        await sendCommand(`EHLO ${host}`);

        // STARTTLS for port 587
        if (port === 587) {
          await sendCommand('STARTTLS');
          // Upgrade to TLS
          socket.upgradeTLS?.({});
          await waitForResponse().catch(() => {}); // Some servers don't respond after upgrade
        }

        // AUTH LOGIN
        await sendCommand('AUTH LOGIN');
        await sendCommand(btoa(user));
        const authResult = await sendCommand(btoa(pass));

        if (!authResult.startsWith('235')) {
          socket.end();
          throw new Error(`SMTP Auth failed: ${authResult}`);
        }

        // MAIL FROM
        await sendCommand(`MAIL FROM:<${from}>`);

        // RCPT TO (for each recipient)
        for (const rcpt of recipients) {
          await sendCommand(`RCPT TO:<${rcpt}>`);
        }

        // DATA
        await sendCommand('DATA');

        // Send message body (dot-stuffing)
        const stuffed = message.replace(/^\./gm, '..');
        socket.write(stuffed + '\r\n.\r\n');
        const dataResult = await waitForResponse();

        // QUIT
        socket.write('QUIT\r\n');
        socket.end();

        resolve(dataResult);
      } catch (err) {
        reject(err);
      }
    });
  }
}

/* ═══════ HELPERS ═══════ */

function encodeSubject(subject: string): string {
  // Check if subject needs encoding (non-ASCII chars)
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  // RFC 2047 encoded-word
  return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;
}

/* ═══════ PUBLIC API ═══════ */

/**
 * Create a mailer instance.
 *
 * @example
 *   const mailer = createMailer({
 *     host: 'smtp.gmail.com',
 *     port: 587,
 *     user: 'you@gmail.com',
 *     pass: 'app-password',
 *     fromName: 'My App',
 *   });
 *
 *   await mailer.send({
 *     to: 'user@example.com',
 *     subject: 'Welcome!',
 *     html: '<h1>Welcome to My App</h1>',
 *   });
 */
export function createMailer(config: SMTPConfig): SMTPClient {
  return new SMTPClient(config);
}

/** Simple template engine for emails */
export function emailTemplate(html: string, variables: Record<string, string>): string {
  let result = html;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

export type { SMTPConfig, EmailMessage, SendResult };
