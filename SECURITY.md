# Security policy · Güvenlik politikası

## English

* Please report security problems **privately** via GitHub → *Security* → *Report a vulnerability* (or contact the
  maintainer), not in a public issue.
* Never post API keys, OAuth tokens, `.env` contents or stream keys in issues, pull requests or chat logs. If a key was
  exposed, revoke it immediately in the Google / Twitch / Kick console.
* The admin panel uses plain HTTP and is meant for `localhost` or a private network such as Tailscale. Set a long
  `ADMIN_TOKEN` whenever `HOST` is not `127.0.0.1`, and never forward port 3000 on your router.
* Only the Kick webhook port should be exposed through a tunnel; every webhook is verified with Kick's RSA signature.

## Türkçe

* Güvenlik sorunlarını herkese açık issue yerine **özel olarak** bildir: GitHub → *Security* → *Report a vulnerability*
  (veya proje sahibine ulaş).
* API anahtarlarını, OAuth token'larını, `.env` içeriğini veya yayın anahtarını issue, pull request ya da sohbet
  kayıtlarında paylaşma. Bir anahtar açığa çıktıysa Google / Twitch / Kick panelinden hemen iptal et.
* Yönetim paneli şifresiz HTTP kullanır ve `localhost` veya Tailscale gibi özel bir ağ içindir. `HOST` `127.0.0.1` değilse
  uzun bir `ADMIN_TOKEN` belirle ve modemde 3000 portunu asla dışarı açma.
* Tünelle sadece Kick webhook portu açılmalıdır; her webhook Kick'in RSA imzasıyla doğrulanır.
