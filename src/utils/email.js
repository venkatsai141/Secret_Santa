const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_SMTP_HOST,
  port: process.env.EMAIL_SMTP_PORT,
  secure: false,
  auth: {
    user: process.env.EMAIL_SMTP_USER,
    pass: process.env.EMAIL_SMTP_PASS
  }
});

async function sendSantaEmail(to, gift, address) {
  const mailOptions = {
    from: process.env.ADMIN_EMAIL,
    to,
    subject: "🎁 You Are a Secret Santa!",
    html: `
      <h2>You have been chosen as a Secret Santa! 🎅</h2>
      <p><b>Gift Wish:</b> ${gift}</p>
      <p><b>Delivery Address:</b> ${address}</p>
      <p><i>Recipient name is hidden for secrecy.</i></p>
      <br/>
      <p>Please send your gift and mark it as sent in the portal ✅</p>
    `
  };

  await transporter.sendMail(mailOptions);
}

module.exports = { sendSantaEmail };
