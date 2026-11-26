# Journal des modifications

## 1.0.3 - 2026-11-26

- Fin de partie : le bouton « Rejouer » relance une partie. Le garde-fou sur `started` bloquait la relance ; le score courant repart à zéro et le record est conservé.
- Vérification : trois billes lancées puis perdues, écran de fin, relance et score à zéro.
- Image Open Graph, capture de documentation et vignette rafraîchies.

## 1.0.2 - 2026-11-26

- Rampe de lancement dégagée : le mur droit `railRight` et l'orbite droite empiétaient sur le tube du plongeur. La bille montait puis retombait sans sortir.
- Point de sortie reculé à (385, 110) pour éviter la courbe supérieure droite.
- Relance : `launchPlunger` retrouve une bille restée dans la rampe même si la référence a été perdue ; les boutons souris, tactile et clavier rappellent le lancement sans condition.
- Textes : « 60 HZ • PHYSIQUE MATTER.JS » et « FLIPPERS PHYSIQUES ».

## 1.0.1 - 2026-11-26

- Record initial remis à zéro : plus de faux score de 125 400 points avant la première partie. Un enregistrement existant est conservé.
- Remplacement des tirets cadratins visibles dans les contrôles, les astuces et la signature par des deux-points ou des virgules.

## 1.0.0 - 2026-11-26

- Import de la variante `retro-pinball-machine-development (1).zip`.
- Base Vite passée à `/stardust-flipper/`.
- Polices Fragment Mono, Space Grotesk et Syne téléchargées et auto-hébergées.
- Liens Google Fonts retirés de la page.
- Titre publié en français : Flipper Stardust '87.
- Textes visibles traduits : départ, partie terminée, plongeur.
- Licence AGPL-3.0-or-later et README de publication.
