# Cartouche

Ma bibliothèque de jeux Game Boy, Game Boy Color et Nintendo DS pour Windows.
Cartouche lance les jeux via [RetroArch](https://www.retroarch.com) avec les moteurs
SameBoy et melonDS DS, qu'elle installe automatiquement au premier lancement.

Aucun jeu n'est fourni : utilise les copies de tes propres cartouches.

## Installer
Télécharge `Cartouche-Setup-x.y.z.exe` dans la page **Releases** et lance-le.
L'app se met ensuite à jour toute seule.

## Publier une nouvelle version
1. Changer `version` dans `package.json`.
2. Créer une étiquette `vX.Y.Z` et la pousser : GitHub construit et publie l'installateur.
