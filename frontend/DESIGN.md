# Fetchly — Design System

Socle design partagé par toutes les vues. **On formalise l'existant, on ne
redessine pas.** Avant d'ajouter une feature, on réutilise ces composants et ces
règles plutôt que d'inventer un énième état vide ou une nouvelle couleur.

Stack : Next.js · shadcn/ui · Tailwind v4 · police Geist · dark mode via
`theme-provider`. Tokens dans [`app/globals.css`](app/globals.css) (`@theme
inline` + variables shadcn).

---

## 1. Principes

### Calme par défaut, dense sur demande

**Une page = une intention.** L'écran par défaut est calme : peu d'éléments,
hiérarchie claire, pas de bruit. La densité (détails, options avancées, listes
longues) apparaît **à la demande** — au survol, à l'expansion, dans un onglet
secondaire — jamais imposée d'emblée.

### Feedback immédiat (< 100 ms)

Toute action a une réponse perceptible en moins de 100 ms :

1. **Optimiste d'abord** — l'UI reflète l'intention immédiatement (l'élément
   apparaît/disparaît, l'état change) sans attendre le réseau.
2. **Toast Sonner en confirmation** — le résultat réel est confirmé par un toast
   (`toast.success` / `toast.error` / `toast.info`). En cas d'échec, on annonce
   l'erreur et on revient à l'état précédent.

### États toujours dessinés

Aucune zone de contenu ne reste « brute » (texte seul, blanc, spinner nu). Les
trois états non-heureux sont **toujours** rendus via des composants dédiés :

| État        | Rendu                                                             |
| ----------- | ----------------------------------------------------------------- |
| **Loading** | `Skeleton` (silhouette du contenu à venir)                        |
| **Vide**    | Composant `Empty` **avec une action primaire** quand c'en est une |
| **Erreur**  | Message **actionnable** + bouton **Réessayer**                    |

→ Utiliser [`components/inline-feedback.tsx`](components/inline-feedback.tsx) qui
encapsule les trois cas. Ne pas réécrire des `<div>` centrées ad hoc.

### Destructif : confirmé, si possible annulable

- Toute action **destructive ou irréversible** passe par une confirmation :
  [`components/confirm-dialog.tsx`](components/confirm-dialog.tsx) (`variant`
  `destructive` par défaut).
- Quand l'action est **réversible côté client**, préférer l'exécution optimiste
  + un toast **« Annuler » pendant 5 s** (`toast(..., { action: { label:
  "Annuler", onClick }, duration: 5000 })`) plutôt qu'un dialog bloquant.
- **Jamais** de `confirm()` / `alert()` natifs.

---

## 2. Vocabulaire de statuts (source de vérité unique)

**Source unique : [`lib/status.ts`](lib/status.ts) → `STATUS_META`.** Tout
affichage de statut consomme cette map via
[`components/status-badge.tsx`](components/status-badge.tsx). **Interdit
d'inventer d'autres couleurs** — on reste sur les tokens ci-dessous.

Chaque statut = **1 token de couleur + 1 icône lucide + 1 libellé FR**.

| Concept (produit)     | Identifiant code | Token / couleur          | Icône lucide     | Libellé FR       |
| --------------------- | ---------------- | ------------------------ | ---------------- | ---------------- |
| queued                | `queued`         | neutre (`muted`)         | `Clock`          | En file          |
| downloading / running | `downloading`    | primaire **animé**       | `Download` (pulse) | Téléchargement |
| processing            | `converting`     | primaire                 | `Loader2` (spin) | Conversion       |
| paused                | `paused`         | ambre (`warning`)        | `Pause`          | En pause         |
| done                  | `completed`      | vert (`success`)         | `Check`          | Terminé          |
| error                 | `failed`         | rouge (`destructive`)    | `TriangleAlert`  | Échec            |
| canceled              | `canceled`       | gris barré (`muted`)     | `Ban`            | Annulé           |

Notes :

- Les identifiants code (`converting`, `completed`, `failed`) sont conservés pour
  ne pas casser le mapping backend (`store-provider.tsx`). Le concept produit
  (`processing`, `done`, `error`) est la façon d'en parler.
- « animé » = l'icône bouge (`animate-pulse` / `animate-spin`) pour signaler un
  travail en cours ; les états terminaux (done/error/canceled) sont statiques.
- `canceled` : libellé **barré** (`line-through`) en plus du gris.

Ajouter un statut = ajouter **une entrée dans `STATUS_META`** (+ l'union
`DownloadStatus` dans [`lib/types.ts`](lib/types.ts)). Rien d'autre à toucher.

---

## 3. Formulaires

- **Label au-dessus** du champ.
- **Texte d'aide en dessous**, en `text-muted-foreground` (`text-xs`).
- **Validation inline au blur** (pas à chaque frappe), message d'erreur sous le
  champ, `aria-invalid` sur le champ concerné.
- **Jamais** d'`alert()` natif — un message inline ou un toast.
- Regrouper les réglages en `Card` par intention (Général / Performance /
  Options…), une ligne = un réglage (voir `Row` dans `settings-view`).

```tsx
<div className="flex flex-col gap-2">
  <Label htmlFor="dir">Dossier de téléchargement</Label>
  <Input id="dir" … />
  <p className="text-xs text-muted-foreground">Aide contextuelle.</p>
</div>
```

---

## 4. Accessibilité

- **Focus visible partout** : ne jamais retirer l'anneau de focus (les variants
  `button`/`badge` embarquent déjà `focus-visible:ring`). Tout est atteignable et
  actionnable **au clavier**.
- **Boutons icône** : `aria-label` obligatoire (bouton sans texte visible). Les
  icônes purement décoratives (dans un badge/label déjà textuel) sont
  `aria-hidden`.
- **Contrastes AA** : les paires token `*/foreground` respectent AA. Les fonds
  translucides des statuts (`bg-*/15 text-*`) sont validés sur `background`
  clair et sombre — ne pas descendre le texte sous le token plein.
- **États live** : `role="status"` + `aria-live="polite"` pour le chargement,
  `role="alert"` pour les erreurs (fournis par `InlineFeedback`).

---

## 5. Composants du socle

| Composant                                               | Rôle                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| [`status-badge.tsx`](components/status-badge.tsx)       | Rendu d'un statut depuis `STATUS_META` (icône + libellé + couleur).  |
| [`inline-feedback.tsx`](components/inline-feedback.tsx) | États `loading` / `empty` / `error` avec slot d'action.              |
| [`confirm-dialog.tsx`](components/confirm-dialog.tsx)   | Confirmation générique pour toute action destructive.                |

### `InlineFeedback`

```tsx
<InlineFeedback
  state="empty"
  icon={DownloadIcon}
  title="Aucun téléchargement"
  description="Collez une URL depuis l'accueil pour commencer."
  action={<Button onClick={…}>Nouveau téléchargement</Button>}
/>

<InlineFeedback state="loading" rows={3} />

<InlineFeedback
  state="error"
  title="Chargement impossible"
  description="Vérifiez le backend puis réessayez."
  action={<Button variant="outline" onClick={retry}>Réessayer</Button>}
/>
```

### `ConfirmDialog`

```tsx
const [removing, setRemoving] = useState<Item | null>(null)

<ConfirmDialog
  open={!!removing}
  onOpenChange={(o) => !o && setRemoving(null)}
  title="Retirer l'abonnement ?"
  description="Il ne sera plus synchronisé. Les vidéos déjà téléchargées sont conservées."
  confirmLabel="Retirer"
  onConfirm={() => removing && removeSubscription(removing.id)}
/>
```

---

## 6. Interdits

- ❌ Nouvelle dépendance UI.
- ❌ Nouvelle couleur hors tokens (`primary`, `muted`, `success`, `warning`,
  `destructive`, `info`…).
- ❌ Refonte de layout / redesign visuel.
- ❌ État vide « brut » (texte seul), spinner nu, `alert()`/`confirm()` natifs.
