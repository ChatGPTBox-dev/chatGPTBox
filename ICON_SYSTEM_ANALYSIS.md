# ChatGPTBox Selection Tools İkon Sistemi Analizi

**Tarih:** 20 Ekim 2025  
**Hedef:** Custom selection tools için ikon çeşitliliğini artırma veya text-based menu geliştirme

---

## Mevcut Durum

### İkon Kaynakları
- `react-bootstrap-icons` (v1.11.4) – ~2000+ ikon içerir
- `@primer/octicons-react` (v18.3.0) – edit/trash gibi aksiyonlar için kullanılıyor

### Kullanılan İkonlar (built-in tools)
1. `ChatText` – Explain
2. `Translate` – Translate
3. `Globe` – Translate (To English/Chinese/Bidirectional) — **3 farklı tool aynı ikonu kullanıyor**
4. `CardHeading` – Summary
5. `Palette` – Polish
6. `EmojiSmile` – Sentiment Analysis
7. `CardList` – Divide Paragraphs
8. `Braces` – Code Explain
9. `QuestionCircle` – Ask

**Toplam:** 9 unique icon, ama 3 tanesi (Globe) tekrar ediyor → etkili olarak **7 farklı görsel**.

### Sorun Tanımı

**Custom Selection Tools Akışı:**
1. Kullanıcı Settings > Modules > Selection Tools'dan "New" tıklar.
2. Name, Icon (dropdown), Prompt Template girer.
3. Icon dropdown'u **sadece built-in 10 tool'un anahtarlarını içerir** (explain, translate, translateToEn, translateToZh, translateBidi, summary, polish, sentiment, divide, code, ask).
4. Birden fazla custom tool aynı ikonu alırsa (örneğin 3 tane "Globe"), görsel olarak ayırt edilemez hale gelir.
5. Tooltip (title) ile ismi görebilirsiniz ama hızlı bir bakışta karışıklık yaratıyor.

### Kod Lokasyonu
- **İkon tanımları:** `src/content-script/selection-tools/index.mjs` – `config` objesi
- **Custom tool düzenleme UI:** `src/popup/sections/SelectionTools.jsx` – dropdown sadece `defaultConfig.selectionTools` key'lerini listeliyor
- **FloatingToolbar render:** `src/components/FloatingToolbar/index.jsx` – `cloneElement(toolsConfig[iconKey].icon, ...)` ile ikonu inject ediyor
- **CSS:** `src/content-script/styles.scss` – `.chatgptbox-selection-toolbar-button` style (24px icon, hover renk, border-radius)

---

## Çözüm Yolları & Çaba Tahmini

### Seçenek 1: İkon Havuzunu Genişletme

**Yaklaşım:**
- `src/content-script/selection-tools/index.mjs` içindeki `config` objesine yeni tool anahtarları ekle (ör. `dummyIcon1`, `dummyIcon2`, ...) ve her birine benzersiz bir `react-bootstrap-icons` ikonu ata.
- `defaultConfig.selectionTools` dizisine bu yeni key'leri ekle (built-in tool gibi görünür ama genPrompt ataması olmaz).
- Dropdown otomatik yeni key'leri gösterir; kullanıcı custom tool için istediği ikonu seçer.

**Değişiklikler:**
- `src/content-script/selection-tools/index.mjs`: +15–30 satır (10–20 yeni dummy key)
- `src/config/index.mjs`: `defaultConfig.selectionTools` dizisine yeni key'ler ekle
- i18n: `src/_locales/en/main.json` (ve diğer diller) – her yeni key için label ekle (ör. "Icon 1", "Icon 2", ...)

**Avantajları:**
- Minimal kod değişikliği (mevcut dropdown mantığını kullanıyor)
- Kullanıcı istediği benzersiz ikonu seçebilir
- Geriye dönük uyumlu

**Dezavantajları:**
- Dummy key'ler yapay; kod temizliği düşük
- UI dropdown uzar (20–30 item); arama/filtreleme yok
- Her yeni ikon için i18n eklemek zahmetli

**Efor Tahmini:**
- Geliştirme: **2–4 saat**
- Test (built-in + custom tools, icon çakışmaları): **1–2 saat**
- i18n güncelleme (12 dil × 20 key): **1–2 saat**
- **Toplam: 4–8 saat**

---

### Seçenek 2: Dinamik İkon Seçici (react-bootstrap-icons Kataloğu)

**Yaklaşım:**
- Dropdown yerine `react-bootstrap-icons` paketinden tüm icon isimlerini otomatik import et veya hardcode liste oluştur.
- Custom tool UI'da searchable/paginated icon picker ekle (küçük görsel grid).
- Seçilen icon'un adını `customSelectionTools[].iconKey` olarak sakla; FloatingToolbar render sırasında dynamic import ile yükle.

**Değişiklikler:**
- `src/popup/sections/SelectionTools.jsx`: Dropdown → Icon Picker component (yeni bileşen, arama/sayfalama)
- `src/components/FloatingToolbar/index.jsx`: `toolsConfig[iconKey].icon` yerine dynamic icon resolver (string → React component)
- `src/content-script/selection-tools/index.mjs`: İkon mapping mantığı ekle veya built-in config'den ayır

**Avantajları:**
- 2000+ icon erişimi; sınır yok
- Kullanıcı dostu arama/filtreleme
- Gerçek bir "icon picker" deneyimi

**Dezavantajları:**
- Yeni UI bileşeni (tasarım + kodlama + responsive)
- Dynamic import mantığı (bundle size vs runtime import trade-off)
- Test surface alanı büyür (icon yükleme hataları, fallback)

**Efor Tahmini:**
- Icon picker component: **6–10 saat** (UI, search, grid layout, responsive)
- Dynamic icon resolver: **3–4 saat** (import logic, error handling, fallback)
- FloatingToolbar integration: **2–3 saat**
- Test & bug fix: **3–4 saat**
- **Toplam: 14–21 saat**

---

### Seçenek 3: Text-Based / Hybrid Menu (İkonlarla birlikte veya sadece text)

#### Yaklaşım A (Hybrid: Icon + Text)
- FloatingToolbar'da ikon + kısa text label göster (örneğin ikon yanında "Explain", "Translate" vs.).
- Custom tool için isim zaten var; built-in tools için `t(toolConfig.label)` kullan.
- CSS ile layout ayarla: flexbox, horizontal/vertical seçenekleri, wrap.

**Değişiklikler:**
- `src/components/FloatingToolbar/index.jsx`: `cloneElement` yerine custom JSX (icon + span)
- `src/content-script/styles.scss`: `.chatgptbox-selection-toolbar-button` → flex container, text style, gap, max-width/overflow
- Ayarlar panelinde "Show text labels" toggle ekle

**Avantajları:**
- Anında ayırt edilebilir (icon + text)
- Kod değişikliği minimal (mevcut yapı korunur)
- İkon çakışması sorunu çözülür (text fallback)

**Dezavantajları:**
- Toolbar genişler (horizontal scroll veya wrap gerekebilir)
- Mobile'da text okunaklığı azalabilir

**Efor Tahmini:**
- FloatingToolbar JSX update: **2–3 saat**
- CSS layout (responsive, overflow, truncate): **2–3 saat**
- Config toggle (ayarlar paneli): **1–2 saat**
- Test (farklı ekran boyutları, çok tool): **2–3 saat**
- **Toplam: 7–11 saat**

#### Yaklaşım B (Text-Only Compact Menu)
- Tek ikon göster; tıklayınca dropdown açılır (mini context menu).
- Liste formatında tool isimleri; arama yapılabilir.
- Tercih edilen tool'ları pin'le (favori sistemi).

**Değişiklikler:**
- FloatingToolbar yeni state (expanded/collapsed)
- Dropdown list component (position, z-index, click-outside close)
- Built-in + custom tool'ları birleştiren yeni render logic

**Avantajları:**
- Çok sayıda tool olsa bile tek buton; horizontal space tasarrufu
- Arama ile hızlı erişim (10+ tool varsa çok faydalı)
- Custom tool sayısı sınırsız

**Dezavantajları:**
- Ekstra tıklama adımı (dropdown açma)
- UX değişikliği; mevcut akışa alışkın kullanıcılar alışmalı

**Efor Tahmini:**
- Dropdown list component: **4–6 saat**
- FloatingToolbar state management: **2–3 saat**
- Arama/filtreleme logic: **2–3 saat**
- CSS (dropdown position, animation): **2–3 saat**
- Test: **2–3 saat**
- **Toplam: 12–18 saat**

---

## Önerilen Yaklaşım

### Kısa vadeli (hızlı win): **Seçenek 1 (İkon Havuzunu Genişletme)**
- Minimum çaba, maksimum etki.
- 15–20 benzersiz icon ekleyerek custom tool'lar daha ayırt edilebilir hale gelir.
- Kullanıcılar dropdown'dan rahatça seçim yapabilir.

### Uzun vadeli (kullanıcı deneyimi iyileştirmesi): **Seçenek 3A (Hybrid: Icon + Text)**
- Icon + text gösterimi modern ve net.
- Custom tool isimlerini direkt toolbar'da görmek UX'i güçlendirir.
- İlerleyen zamanda ayarlar paneline "Text-only mode" veya "Compact dropdown" seçeneği eklenebilir.

---

## Teknik Detaylar & Dosya Haritası

| Dosya | Rol | Değişiklik Gereksinimi |
|-------|-----|------------------------|
| `src/content-script/selection-tools/index.mjs` | Built-in tool config (icon mapping) | Seçenek 1: +10–20 key; Seçenek 2: icon resolver; Seçenek 3: değişmez |
| `src/popup/sections/SelectionTools.jsx` | Custom tool düzenleme UI | Seçenek 1: değişmez; Seçenek 2: icon picker UI ekle; Seçenek 3: değişmez |
| `src/components/FloatingToolbar/index.jsx` | Toolbar render logic | Seçenek 1: değişmez; Seçenek 2: dynamic import; Seçenek 3: JSX/state güncelle |
| `src/content-script/styles.scss` | Toolbar button style | Seçenek 3: flex layout, text style, responsive |
| `src/config/index.mjs` | Default config | Seçenek 1: yeni key'ler ekle; Seçenek 3: toggle flag |
| `src/_locales/*/main.json` | i18n labels | Seçenek 1: yeni key labels; Seçenek 3: hybrid mode labels |

---

## Kod Snippet Örnekleri (Referans)

### Seçenek 1: Yeni İkon Ekleme

```javascript
// src/content-script/selection-tools/index.mjs
import {
  // ... mevcut iconlar
  StarFill,
  Lightbulb,
  Bookmark,
  // ... 15-20 yeni icon import
} from 'react-bootstrap-icons'

export const config = {
  // ... mevcut built-in tools
  iconStar: {
    icon: <StarFill />,
    label: 'Icon: Star',
    genPrompt: null, // dummy, sadece icon seçimi için
  },
  iconLightbulb: {
    icon: <Lightbulb />,
    label: 'Icon: Lightbulb',
    genPrompt: null,
  },
  // ...
}
```

### Seçenek 3A: Hybrid Icon + Text

```jsx
// src/components/FloatingToolbar/index.jsx (pushTool fonksiyonu)
const pushTool = (iconKey, name, genPrompt) => {
  const IconComponent = toolsConfig[iconKey].icon
  tools.push(
    <div
      key={iconKey}
      className="chatgptbox-selection-toolbar-button"
      title={name}
      onClick={async () => {
        const p = getClientPosition(props.container)
        props.container.style.position = 'fixed'
        setPosition(p)
        setPrompt(await genPrompt(selection))
        setTriggered(true)
      }}
    >
      {cloneElement(IconComponent, { size: 20 })}
      {config.showTextLabels && <span className="tool-label">{name}</span>}
    </div>
  )
}
```

```scss
// src/content-script/styles.scss
.chatgptbox-selection-toolbar-button {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  // ...

  .tool-label {
    font-size: 12px;
    white-space: nowrap;
    max-width: 80px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
```

---

## Sonraki Adımlar

1. **Karar:** Hangi seçeneği uygulayacağınızı belirleyin (Seçenek 1 hızlı, Seçenek 3A uzun vadeli).
2. **Prototype:** Seçilen yaklaşım için küçük bir PoC (proof of concept) oluşturun.
3. **PR hazırlığı:**
   - Branch: `feat/selection-tools-icon-expansion` veya `feat/selection-tools-text-labels`
   - Commit mesajı: `feat(selection-tools): add X new icon options` veya `feat(ui): add text labels to selection toolbar`
4. **Test:**
   - Built-in + custom tools kombinasyonu
   - Farklı ekran boyutları (desktop, tablet, mobile)
   - Çok sayıda tool (10+)
5. **i18n:** Yeni label'lar için EN/TR ve diğer diller güncellenmeli.

---

**Not:** Bu analiz değişiklik yapmadan yalnızca mevcut durumu ve geliştirme yollarını belgelemektedir.
