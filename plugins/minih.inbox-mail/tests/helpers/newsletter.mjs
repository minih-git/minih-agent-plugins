/**
 * A newsletter, as one arrives in a real mailbox.
 *
 * Nested layout tables (no borders of their own), a `<style>` block in the head
 * that carries the whole design, inline colours on the cells, one remote image,
 * and an `<a>` that must not navigate the panel. It is the fixture the reading
 * pane's rules are asserted against: the stylesheet has to survive, the cells must
 * not get a border, and the image must stay blocked until asked for.
 */
export const NEWSLETTER_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>November news</title>
  <style>
    @import url(https://tracker.example/newsletter.css);
    body { margin: 0; background: #f4f5f7; }
    .paper { width: 600px; margin: 0 auto; background: #ffffff; color: #063; }
    .paper h1 { font-size: 22px; color: #0a3d62; }
    .paper td { padding: 12px 16px; border: 0; }
    .footer { font-size: 12px; color: #777777; }
  </style>
</head>
<body>
  <table class="paper" role="presentation">
    <tr>
      <td>
        <h1>十一月简报</h1>
        <table role="presentation">
          <tr>
            <td><img src="https://cdn.example/hero.png" alt="hero" width="560" /></td>
          </tr>
          <tr>
            <td style="color:#c0392b">这一期的重点是发布说明。</td>
          </tr>
        </table>
        <p class="footer">
          <a href="https://example.com/unsubscribe">退订</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;