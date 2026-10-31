# IntelliFire

Intégration Gladys pour les foyers au gaz **IntelliFire** (Hearth & Home Technologies : Heat & Glo,
Heatilator, Majestic, Monessen, Quadra-Fire) équipés du module Wi-Fi IFT, par l'**API locale** de ce
module. Jamais testé avec un vrai foyer : construit et testé sur un faux module d'après la bibliothèque
intellifire4py (celle de Home Assistant). Sans lien avec Hearth & Home Technologies.

> Une flamme de gaz allumée à distance est un risque. N'autorisez l'allumage depuis Gladys que si
> rien ne repose près du foyer et que personne ne peut être surpris par la flamme.

## Ce que vous obtenez

Un appareil par foyer, identifié par son numéro de série (jamais par son adresse IP) :

- état (texte), flamme allumée, veilleuse permanente, vitre chaude, température de la pièce (°C, telle
  que le module la donne), mode thermostat, consigne du thermostat, minuterie restante (min),
  niveau d'éclairage (0 à 3, lecture seule), défaut signalé et liste des défauts ;
- **Éteindre** (bouton), jamais soumis à l'option ;
- **Allumer** (bouton), **Hauteur de flamme** (1 à 5), **Vitesse du ventilateur** (arrêt, 1 à 4) et
  **Consigne du thermostat** (°C entiers) : désactivés tant que l'option « Autoriser l'allumage, la
  flamme, le ventilateur et la consigne » n'est pas cochée.

Aucun de ces réglages n'est un interrupteur : un « tout éteindre » (assistant vocal, scène) n'atteint
jamais la flamme.

## Installation

1. Donnez au module Wi-Fi du foyer une adresse fixe dans votre box.
2. Saisissez cette adresse, enregistrez : le foyer est lu, l'appareil apparaît dans l'onglet Découverte.
3. Pour les commandes (extinction comprise), il faut la **clé** du foyer et l'**identifiant
   utilisateur** de votre compte IntelliFire : saisissez l'adresse e-mail et le mot de passe du
   compte, enregistrez, puis cliquez sur **Récupérer la clé**. Gladys se connecte une seule fois au
   cloud IntelliFire (iftapi.net, en HTTPS), prend la clé du foyer dont le numéro de série a été lu à
   l'adresse et l'enregistre. Vous pouvez ensuite effacer le mot de passe. Vous pouvez aussi saisir
   la clé et l'identifiant vous-même.

Le mot de passe, la clé et l'identifiant sont gardés par Gladys dans sa base, jamais réaffichés, jamais
écrits dans les journaux ni dans /data. Le mot de passe n'est envoyé qu'à iftapi.net et seulement au
clic ; l'identifiant n'est envoyé qu'au foyer ; la clé ne quitte pas Gladys (elle signe les commandes).
Les lectures de l'API locale ne demandent aucun mot de passe : gardez le foyer sur un réseau de
confiance.

## Lectures

Le foyer est lu toutes les 15 s par défaut (10 à 600 s), pas plus souvent, même après un redémarrage
(l'heure de la dernière lecture est gardée dans /data), puis 5 s et 20 s après chaque commande. Une
seule requête à la fois vers le module. Une valeur absente ou illisible n'est pas publiée (jamais comme 0) ; rien de plus vieux que 2 minutes n'est envoyé comme neuf.

## Éteindre

Le bouton **Éteindre** envoie l'extinction (puissance 0), puis remet la consigne du thermostat à 0 (pour
qu'aucun thermostat ne rallume la flamme). Il ne dépend ni de l'option, ni d'une lecture préalable, ni
d'une pause demandée par le module, ni d'une commande en cours (il l'interrompt : une commande cliquée
avant lui et pas encore partie est abandonnée), ni d'une lecture bloquée (il la coupe). Il part vers
l'adresse saisie, ou celle de la dernière lecture gardée dans /data si la configuration n'est pas lue.

L'extinction ne peut pas partir, et elle est **gardée** (dans /data) jusqu'à ce qu'elle parte, dans ces
cas exactement :

- aucune adresse connue (ni saisie, ni gardée) : refusée, rien n'est gardé ;
- pas de clé ou d'identifiant valides : elle part dès qu'ils sont enregistrés (bouton ou saisie) ;
- le foyer refuse la clé ou l'identifiant (HTTP 403, deux fois avec un nouveau défi) : elle n'est plus
  essayée d'elle-même ; elle part dès qu'une nouvelle clé est enregistrée, à une lecture réussie par le
  bouton « Tester la connexion », ou à un nouveau clic ;
- après un redémarrage, elle attend la lecture de la configuration (la clé est un secret, jamais dans
  /data) ;
- le module ne répond pas : essayée toutes les 250 ms pendant 3 s, puis toutes les 15 s.

Une extinction est confirmée seulement par une lecture qui montre la flamme éteinte et le thermostat
arrêté. Sinon elle est relue toutes les 15 s et renvoyée tant que la flamme est allumée, 3 fois au plus ;
ensuite elle est retenue (dit dans le statut) sans nouvel envoi jusqu'à un nouveau clic. Elle est
levée par une lecture montrant le foyer éteint (deux lectures de suite si elle n'est jamais partie), ou
par un allumage cliqué ensuite depuis Gladys avec l'option ; jamais par le temps.

## Allumer, flamme, ventilateur, consigne

Désactivés par défaut. Avec l'option, chaque commande lit d'abord le foyer (lecture fraîche, jamais
l'état en mémoire) et vérifie de nouveau l'option juste avant chaque envoi. **Allumer** envoie la
flamme puis, aussitôt, une **minuterie** (60 min par défaut, 10 à 180) : le foyer s'éteint de lui-même
à son terme. Si la minuterie ne peut pas être posée, Gladys éteint le foyer aussitôt ; si les lectures
des deux minutes suivantes montrent la flamme sans cette minuterie, Gladys l'éteint aussi.

Une commande est refusée, sans rien envoyer, quand :

- l'option est décochée, ou la configuration pas encore lue ;
- la clé ou l'identifiant manquent, ou le foyer les a refusés ;
- une autre commande est en cours, une extinction est en cours d'envoi, ou (sauf pour Allumer) une
  extinction est gardée ;
- le module a demandé d'attendre (HTTP 429 ou 503) ;
- la lecture fraîche échoue ou ne vient pas à temps (la commande doit partir dans les 3,5 s) ;
- le foyer lu n'est pas cet appareil (autre numéro de série) ;
- une valeur nécessaire manque à la lecture ;
- Allumer : un défaut qui désactive le foyer est signalé (veilleuse, flamme, appareil désactivé,
  verrouillage, hors ligne, ECM hors ligne, ou un code inconnu), ou /data ne peut pas être écrit ;
- Hauteur de flamme et Consigne : le foyer est éteint (Gladys ne les envoie pas à un foyer éteint) ;
- Ventilateur : le foyer n'a pas de ventilateur ; Consigne : il n'a pas de thermostat ;
- la valeur sort des bornes : hauteur 1 à 5, ventilateur 0 à 4, consigne de 5 °C à la « consigne la
  plus haute » (26 °C par défaut, 37 °C au plus, la limite de l'API).

Une commande est réussie seulement si la relecture montre la valeur demandée ; sinon Gladys répond
« envoyé, pas encore appliqué », « envoyé, sans confirmation » ou « rien envoyé », selon ce qui s'est
passé.

## Statut

L'écran de configuration dit l'état du foyer, une extinction gardée ou retenue, une clé refusée ou
absente, un module injoignable (prochain essai), une pause demandée par le module.
