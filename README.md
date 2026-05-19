# mBot Ranger Control

Application Electron locale pour piloter un **Makeblock mBot Ranger** (carte Me Auriga, configuration Land Raider) au **clavier (ZQSD)** ou à la **manette**, via **USB** ou **Bluetooth**.

## Fonctionnalités

- Liste auto + ouverture/fermeture du port série (USB ou Bluetooth SPP, qui apparaît comme un COM sous Windows)
- Pilotage différentiel des chenilles avec mix throttle/turn
  - **Clavier** : Z avancer, S reculer, Q tourner à gauche, D tourner à droite, **espace** stop d'urgence, `+` / `-` ajustent la vitesse max
  - **Manette** (Xbox/PS) : stick gauche pour la direction, gâchette R2 pour booster, **A** klaxon, **B** stop, **LB** LEDs off, **RB** appliquer la couleur
- Réglage vitesse max (0-255) en live
- Options câblage moteurs : inverser M1, inverser M2, permuter M1↔M2, mode encodeur PWM ou DC direct
- Lecture continue du **capteur ultrason** + affichage et auto-stop sous un seuil configurable
- Contrôle de l'**anneau de 12 LEDs RGB** (par LED ou toutes, couleurs préréglées, effet rainbow)
- **Buzzer** : fréquence + durée, gamme do/ré/mi…, sirène

## Pré-requis

- **Node.js 18+** (testé avec Node 22)
- **Windows 10/11** (l'app fonctionne aussi macOS/Linux, le code est portable)
- **Driver CH340** pour l'USB du mBot — si Windows ne reconnaît pas le port :
  https://www.wch-ic.com/downloads/CH341SER_EXE.html
- **Firmware par défaut** sur la Me Auriga (Firmware_for_Auriga). C'est celui d'usine ; si tu as flashé du code Arduino perso il faudra reflasher via mBlock ou Arduino IDE.

## Installation

```powershell
npm install
npm start
```

Le `postinstall` lance `electron-rebuild` pour recompiler `serialport` contre la version d'Electron — c'est nécessaire car `serialport` utilise du natif. Si tu vois une erreur du genre *"NODE_MODULE_VERSION mismatch"* au démarrage, relance :

```powershell
npm run rebuild
```

## Connexion

### USB (câble)
1. Branche le câble USB de l'Auriga au PC.
2. Vérifie dans le Gestionnaire de périphériques qu'un **COMx (USB-SERIAL CH340)** apparaît.
3. Dans l'app : `↻` pour rafraîchir, sélectionne ton COM, **baud 115200**, clique **Connecter**.

### Bluetooth
1. Allume le mBot (interrupteur sur la batterie).
2. Sur Windows : *Paramètres → Bluetooth → Ajouter un appareil*. Apparie le module Makeblock (PIN par défaut **0000** ou **1234**).
3. Après appairage, Windows crée 2 ports COM virtuels (entrant + sortant). C'est le **sortant** qu'il faut sélectionner.
4. Dans l'app : choisis le port, baud **115200** (ou **9600** / **38400** suivant le firmware du module), puis **Connecter**.

Astuce : un câble USB et un module Bluetooth peuvent cohabiter ; tu verras les deux dans la liste, choisis celui que tu veux utiliser à la connexion.

## Réglages moteurs

Les chenilles peuvent partir dans le mauvais sens selon le câblage (M1/M2 sont sur les deux côtés du chassis, et leurs orientations sont opposées). À la première connexion :

1. Appuie **Z** doucement (vitesse max basse, ~80).
2. Si le robot recule au lieu d'avancer → coche **Inverser M1** et **Inverser M2**.
3. S'il tourne sur place au lieu d'avancer → coche **Permuter M1↔M2**, ou inverse seulement un des deux moteurs.
4. Si **Q** et **D** sont inversés → permute M1↔M2 (ou alterne les deux inversions).

Par défaut **Inverser M2** est coché, ce qui correspond au câblage standard du Land Raider.

## Capteur ultrason

Le port du capteur dépend de l'endroit où tu l'as branché sur l'Auriga. Sur la photo de ton montage la nappe semble aller vers les ports RJ25 du devant ; teste 6, 7, 8 ou 10 jusqu'à voir la distance bouger quand tu mets la main devant.

## Architecture rapide

```
robot/
├── main.js              Processus principal Electron + bridge serialport
├── preload.js           Pont IPC sécurisé (contextBridge)
├── lib/makeblock.js     Protocole Makeblock côté Node (réservé extensions)
└── renderer/
    ├── index.html
    ├── style.css
    ├── makeblock.js     Même protocole, version Uint8Array pour le navigateur
    └── renderer.js      Logique UI : clavier, manette, mix moteur, polling
```

Le renderer ne touche **jamais** directement au port série : il appelle `window.robotApi.writeBytes(...)` qui passe par IPC vers le main process. Les données reçues du port reviennent par l'événement `serial:data`.

## Protocole Makeblock (résumé)

Trame émise vers la carte :

```
0xFF 0x55  LEN  IDX  ACTION  DEVICE  PORT  [DATA...]
```

Trame reçue :

```
0xFF 0x55  IDX  TYPE  [DATA...]  0x0D 0x0A
```

- `ACTION` : 1=GET, 2=RUN, 3=RESET, 4=START
- `DEVICE` utilisés ici : 0 (VERSION), 1 (ULTRASONIC), 8 (RGBLED), 10 (DC_MOTOR), 34 (TONE), 61 (ENCODER_BOARD)
- `TYPE` des réponses : 1=byte, 2=float, 3=short, 4=string, 5=double, 6=long

Pour les moteurs encodeurs de l'Auriga, on utilise `ENCODER_BOARD` (61), port 0, slot 1 (M1) ou 2 (M2), sous-commande 3 (PWM direct -255..255).

## Sécurité

- Stop d'urgence clavier : **espace**
- Bouton **B** de la manette : stop ponctuel
- Si la fenêtre perd le focus, les touches enfoncées sont relâchées
- À la déconnexion, un `RESET` est envoyé avant de fermer le port (stoppe les moteurs)
- Option **auto-stop** : bloque l'avance si l'ultrason détecte un obstacle plus proche que le seuil (la marche arrière et la rotation restent autorisées)

## Limites connues

- Le `TONE` bloque la boucle principale de l'Auriga pendant la durée demandée → garde les durées courtes (< 500 ms) sinon les commandes moteur attendent
- En Bluetooth, la latence est plus élevée (~100-200 ms) qu'en USB ; baisse la vitesse max pour un pilotage plus fluide
- Le firmware d'usine ne renvoie pas systématiquement la version → si tu ne vois pas de ligne "Firmware : …" dans le journal après connexion, ce n'est pas grave
# Project-Robot-Truck

Si tu veux, je peux te le retravailler pour le rendre encore plus pro, format 'prêt à push', ca sera encore mieux.
