# Contributing · Katkıda bulunma

**English** below · **Türkçe** aşağıda

## English

Thanks for helping! Bug reports, ideas, translations, new dances, club decor and performance work are all welcome.

1. **Open an issue first** for larger changes so we can agree on the approach.
2. Fork, create a branch, make your change.
3. Run the checks before opening a pull request:
   ```bash
   npm ci
   npm run typecheck
   npm test
   npm run build
   npm run smoke        # optional, needs the pre-installed Playwright Chromium
   ```
4. Describe **what** you changed and **how you tested it**. Screenshots or short clips help for visual changes.

Guidelines

* Code is TypeScript (strict). Keep the server authoritative; the `/live` page only visualises state.
* Never commit secrets (`.env`, tokens, API keys) or personal data.
* Only add assets with a clear licence that allows redistribution and commercial streaming, and list them in
  `ASSET_LICENSES.md`. No ripped music, game characters or models of unknown origin.
* Keep real and simulated (demo) traffic strictly separate.
* Do not add features that require paying to play, gambling, betting or random paid rewards.
* Do not claim FPS numbers you have not measured with `npm run benchmark` on real hardware.
* UI text needs both English and Turkish.

## Türkçe

Katkın için teşekkürler! Hata bildirimleri, fikirler, çeviriler, yeni danslar, kulüp dekoru ve performans çalışmaları memnuniyetle karşılanır.

1. Büyük değişiklikler için **önce bir issue aç**, yaklaşım üzerinde anlaşalım.
2. Depoyu fork'la, bir dal oluştur, değişikliğini yap.
3. Pull request açmadan önce kontrolleri çalıştır:
   ```bash
   npm ci
   npm run typecheck
   npm test
   npm run build
   npm run smoke        # isteğe bağlı, kurulu Playwright Chromium gerekir
   ```
4. **Neyi** değiştirdiğini ve **nasıl test ettiğini** yaz. Görsel değişikliklerde ekran görüntüsü veya kısa video yardımcı olur.

Kurallar

* Kod TypeScript (strict). Sunucu yetkili kalmalı; `/live` sayfası sadece durumu görselleştirir.
* Gizli bilgi (`.env`, token, API anahtarı) veya kişisel veri commit'leme.
* Sadece yeniden dağıtıma ve ticari yayına izin veren, lisansı net varlıklar ekle ve `ASSET_LICENSES.md`'ye yaz.
  İzinsiz müzik, oyun karakteri veya kaynağı belirsiz model ekleme.
* Gerçek ve simüle (demo) trafiği kesinlikle ayrı tut.
* Oynamak için para gerektiren, kumar, bahis veya rastgele ücretli ödül içeren özellik ekleme.
* Gerçek donanımda `npm run benchmark` ile ölçmediğin FPS değerlerini iddia etme.
* Arayüz metinleri hem Türkçe hem İngilizce olmalı.
