---
name: Precision Network Systems
colors:
  surface: '#f8f9fa'
  surface-dim: '#d9dadb'
  surface-bright: '#f8f9fa'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f4f5'
  surface-container: '#edeeef'
  surface-container-high: '#e7e8e9'
  surface-container-highest: '#e1e3e4'
  on-surface: '#191c1d'
  on-surface-variant: '#424656'
  inverse-surface: '#2e3132'
  inverse-on-surface: '#f0f1f2'
  outline: '#727687'
  outline-variant: '#c2c6d8'
  surface-tint: '#0054d6'
  primary: '#0050cb'
  on-primary: '#ffffff'
  primary-container: '#0066ff'
  on-primary-container: '#f8f7ff'
  inverse-primary: '#b3c5ff'
  secondary: '#006e25'
  on-secondary: '#ffffff'
  secondary-container: '#80f98b'
  on-secondary-container: '#007327'
  tertiary: '#525b62'
  on-tertiary: '#ffffff'
  tertiary-container: '#6a737b'
  on-tertiary-container: '#f4f9ff'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dae1ff'
  primary-fixed-dim: '#b3c5ff'
  on-primary-fixed: '#001849'
  on-primary-fixed-variant: '#003fa4'
  secondary-fixed: '#83fc8e'
  secondary-fixed-dim: '#66df75'
  on-secondary-fixed: '#002106'
  on-secondary-fixed-variant: '#00531a'
  tertiary-fixed: '#dbe4ed'
  tertiary-fixed-dim: '#bfc8d0'
  on-tertiary-fixed: '#141d23'
  on-tertiary-fixed-variant: '#3f484f'
  background: '#f8f9fa'
  on-background: '#191c1d'
  surface-variant: '#e1e3e4'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.05em
  label-sm:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
  headline-md-mobile:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  header-height: 64px
  container-max: 1440px
  gutter: 16px
---

## Brand & Style
The design system focuses on a high-utility, professional aesthetic tailored for network engineers and GIS specialists. The core personality is reliable, systematic, and precise. By leveraging a **Corporate Modern** style with **Minimalist** tendencies, the interface prioritizes data clarity and geographic legibility over decorative elements. 

The emotional response should be one of confidence and efficiency. The UI stays out of the way, providing a clean "canvas" for complex network topologies. Visual hierarchy is established through crisp alignment, deliberate whitespace, and a high-contrast color application that ensures critical network status indicators are immediately identifiable against the map background.

## Colors
The palette is functional and high-visibility. 

- **Primary Blue (#0066FF):** Used for active states, primary actions, and selected network nodes. It signifies the core interactive layer.
- **Success Green (#28A745):** Specifically reserved for "Online" or "Healthy" status indicators within the network topology.
- **Background Light Gray (#F8F9FA):** Provides a neutral foundation for the application shell, ensuring the map and data cards pop.
- **Text Dark Slate (#212529):** Used for all primary content to ensure AAA accessibility and crisp legibility.
- **Surface White (#FFFFFF):** Used for cards, headers, and modals to create a clear distinction from the background.

## Typography
This design system utilizes **Inter** for its exceptional legibility on digital screens, particularly for data-dense environments. 

- **Headlines:** Use Semi-Bold weights to provide structure without feeling heavy.
- **Body Text:** Standard body text uses a 14px base (`body-md`) to maximize the amount of information visible in data cards and property panels.
- **Labels:** Small, uppercase labels with slight letter spacing are used for metadata and category headers to differentiate them from interactive text.
- **Numeric Data:** For coordinates and IP addresses, maintain Inter but ensure tabular lining is used if the implementation allows, keeping columns of numbers aligned.

## Layout & Spacing
The layout follows a **Fluid Grid** approach for the map area, while UI overlays and headers adhere to a fixed 4px baseline rhythm.

- **Header:** A persistent 64px top header contains all primary navigation and global search. 
- **Map Area:** The map is a full-height, full-width element occupying the entire viewport below the header. 
- **Overlays:** Data cards and input panels are positioned as floating elements or anchored "drawers" over the map, using `md` (16px) or `lg` (24px) padding.
- **Breakpoints:** 
  - **Desktop (1024px+):** 12-column logic for content overlays.
  - **Tablet (768px - 1023px):** Overlay panels stack or become full-width bottom sheets.
  - **Mobile (<768px):** Header collapses to a hamburger menu; data input is handled via full-screen modals.

## Elevation & Depth
Depth is communicated through **Tonal Layers** and **Ambient Shadows** to separate the interactive UI from the map background.

- **Level 0 (Map):** The base layer.
- **Level 1 (Cards/Panels):** Surface White with a subtle, highly diffused shadow (`0px 2px 8px rgba(0,0,0,0.08)`) and a 1px border of Background Light Gray to define edges.
- **Level 2 (Dropdowns/Modals):** High-elevation shadows (`0px 8px 24px rgba(0,0,0,0.12)`) to indicate temporary interaction layers that require immediate focus.
- **Nodes:** Map markers use a tight, dark shadow to "lift" them off the map tiles for maximum visibility.

## Shapes
The design system uses **Soft** roundedness (4px) to maintain a professional, architectural feel. 

- **Input Fields & Buttons:** 4px radius (`rounded-sm`).
- **Data Cards:** 8px radius (`rounded-lg`) to provide a distinct container feel against the map.
- **Navigation Items:** Sharp or very slightly rounded (2px) to maintain a technical, "instrument panel" aesthetic.
- **Status Pills:** Fully rounded (pill-shaped) to distinguish them from interactive buttons.

## Components
- **Buttons:** 
  - *Primary:* Solid #0066FF with white text. 
  - *Secondary:* Ghost style with Primary Blue border and text.
  - *Action:* Small square buttons (32x32px) for map controls (Zoom, Pan, Layer Toggle).
- **Cards:** White surfaces with a 1px #E9ECEF border. Headlines in `headline-sm`, content in `body-md`.
- **Inputs:** Background White, 1px #CED4DA border. On focus, the border changes to #0066FF with a subtle 2px glow.
- **Network Nodes:** 
  - *Active:* 12px circle, #0066FF fill, 2px White border.
  - *Alert:* 12px circle, #DC3545 (Danger Red) fill.
- **Lists:** Clean rows with 1px bottom borders. Hover state uses #F8F9FA background.
- **Chips/Pills:** Used for status (e.g., "Fiber," "Copper," "Active"). Small text (`label-sm`) inside a 20px tall pill.