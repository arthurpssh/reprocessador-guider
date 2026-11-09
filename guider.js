const axios = require('axios');

const GUIDER_URL = 'https://api-guider.hotmart.com/v1/zendesk/close';

function closeTicket(ticketId) {
  return axios.put(
    GUIDER_URL,
    { company: 'hotmart', ticketId: String(ticketId) },
    {
      headers: {
        Authorization: `Bearer ${process.env.GUIDER_TOKEN}`,
        'User-Agent': 'Zendesk Webhook',
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );
}

module.exports = { closeTicket };
