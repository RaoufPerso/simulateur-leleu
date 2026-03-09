# Simulateur — Score Composite Leleu et al. (2023)

Simulateur interactif reproduisant l'algorithme de scoring de qualité hospitalière proposé par Leleu, Vimont, Crapeau et Borella dans le *Journal de Gestion et d'Économie de la Santé* (2023, Vol. 41, n° 1, pp. 45-67).

**[➡️ Accéder au simulateur en ligne](https://VOTRE_USERNAME.github.io/simulateur-score-leleu/)**

## Objectif

Illustrer les vulnérabilités théoriques du modèle face aux comportements stratégiques des agents économiques :

- **Biais de sévérité** — Un CHU traitant des patients à haute gravité est pénalisé par ses PSI physiologiques, même évalué contre les seuils CHR.
- **Écrémage** (*Cream Skimming*) — Un établissement sélectionnant ses patients obtient mécaniquement la note maximale.
- **Aléa moral** (*Gaming*) — Un hôpital peut améliorer sa note par sous-codage des complications dans le PMSI.

## Calibrage

Le marché de référence (500 établissements) est généré par distributions log-normales centrées sur les données réelles du **Tableau VI** de l'article (PSI pour 1 000 hospitalisations). Les seuils Q1/Q3 sont calculés **séparément** pour CHR/CHU et Autres, conformément à la section 2.4.3 de l'article.

| Indicateur | Moyenne CHR (article) | Moyenne Autres (article) |
|---|---|---|
| PSI 3 (Escarre) | 32,0 | 28,0 |
| PSI 10 (Métabolique) | 81,0 | 20,0 |
| PSI 12 (Embolie) | 18,0 | 4,5 |
| PSI 13 (Sepsis) | 26,0 | 7,5 |

## Installation locale

```bash
git clone https://github.com/VOTRE_USERNAME/simulateur-score-leleu.git
cd simulateur-score-leleu
npm install
npm run dev
```

## Déployer sur GitHub Pages

Le déploiement est automatique via GitHub Actions. À chaque push sur `main`, l'application est buildée et publiée sur GitHub Pages.

Pour activer :
1. Aller dans **Settings → Pages**
2. Source : **GitHub Actions**
3. Le workflow `.github/workflows/deploy.yml` fait le reste

## Référence

> Leleu H., Vimont A., Crapeau N., Borella L. (2023). *Élaboration d'un score composite pour évaluer la qualité de prise en charge hospitalière*. Journal de Gestion et d'Économie de la Santé, 41(1), 45-67. [DOI: 10.54695/jdds.041.1.0045](https://doi.org/10.54695/jdds.041.1.0045)

## Contexte

Travail réalisé dans le cadre du MBA Executive Santé (Dauphine-PSL) — Module Économie de la santé.

## Licence

MIT
