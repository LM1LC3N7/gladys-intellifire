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
   la clé et l'identifiant vous-même : si le foyer est déjà dans Home Assistant (intégration
   IntelliFire), ce sont les valeurs `api_key` et `user_id` de son entrée de configuration. Ni l'API
   locale du foyer ni sa découverte ne donnent la clé.

Le mot de passe, la clé et l'identifiant sont gardés par Gladys dans sa base, jamais réaffichés, jamais
écrits dans les journaux ni dans /data. Le mot de passe n'est envoyé qu'à iftapi.net et seulement au
clic ; l'identifiant n'est envoyé qu'au foyer ; la clé ne quitte pas Gladys (elle signe les commandes).
Les lectures de l'API locale ne demandent aucun mot de passe : gardez le foyer sur un réseau de
confiance.

## Lectures

Le foyer est lu toutes les 15 s par défaut (10 à 600 s), pas plus souvent, même après un redémarrage
(l'heure de la dernière lecture est gardée dans /data), puis 5 s et 20 s après chaque commande. Une
seule requête à la fois vers le module. Une valeur absente ou illisible n'est pas publiée (jamais comme 0) ; rien de plus vieux que 2 minutes n'est envoyé comme neuf. Quand /data ne peut pas être lu,
l'heure de la dernière lecture est inconnue : le foyer est lu une fois au démarrage (une requête
locale par démarrage, même en boucle de redémarrage).

## Éteindre

Le bouton **Éteindre** envoie l'extinction (puissance 0), puis remet la consigne du thermostat à 0 (pour
qu'aucun thermostat ne rallume la flamme). Chaque envoi demande un défi au module ; un refus HTTP 403 est,
comme le lit intellifire4py, un défi expiré : un nouveau défi est demandé, jusqu'à 10 fois. Elle ne
dépend ni de l'option, ni d'une lecture préalable, ni d'une pause demandée par le module, ni d'une
commande en cours (elle l'interrompt : une commande cliquée avant elle et pas encore partie est
abandonnée), ni d'une lecture bloquée (elle la coupe). Elle part vers l'adresse saisie, ou celle de la
dernière lecture gardée dans /data si la configuration n'est pas lue.

Une extinction appartient à son foyer (son numéro de série) : celui de l'appareil dont le bouton a été
cliqué, jamais le dernier foyer lu. Chaque foyer a sa propre extinction gardée : jusqu'à 4 foyers ayant
une extinction gardée en même temps, un clic sur l'extinction d'un autre appareil n'en lève jamais une.
Au-delà de 4, l'extinction la plus ancienne d'un foyer qui n'est ni celui cliqué ni celui lu à l'adresse
est levée (écrit dans les journaux). Si vous saisissez une nouvelle adresse, les extinctions gardées
la suivent. Si la dernière lecture de l'adresse montre un autre IntelliFire (aussi quand une
vérification ne lit ensuite aucun numéro de série), rien ne lui est envoyé ; si un autre y répond avant
d'avoir été lu, les envois partent vers l'adresse, il les refuse (403) et ce refus ne compte jamais
contre la clé. Dans les deux cas, ses lectures ne lèvent pas l'extinction, le statut le dit, et
l'extinction part dès que ce foyer est relu à l'adresse.

Une extinction n'est signée qu'avec la clé de son propre foyer. Pour autant que Gladys le sache pendant
cette exécution, la clé saisie appartient au foyer qui a accepté un envoi signé avec elle, ou à celui
pour lequel elle a été récupérée par « Récupérer la clé » (gardé en mémoire seulement, jamais dans
/data, oublié quand une autre clé est enregistrée). L'extinction d'un autre foyer n'est alors jamais
signée avec elle. Tant que Gladys ne le sait pas (après un redémarrage, avant tout envoi accepté),
l'extinction part avec la clé saisie.

L'extinction ne peut pas partir, et elle est **gardée** (dans /data) jusqu'à ce qu'elle parte, dans ces
cas exactement :

- aucune adresse connue (ni saisie, ni gardée) : refusée, rien n'est gardé ;
- pas de clé ou d'identifiant valides : elle part dès qu'ils sont enregistrés (bouton ou saisie) ;
- le foyer refuse la clé ou l'identifiant, sur preuve seulement (10 défis refusés en 403 dans un même
  envoi, le numéro de série de ce foyer lu à l'adresse, une clé qu'il n'a jamais acceptée et dont on ne
  sait pas qu'elle appartient à un autre foyer) : elle n'est plus essayée d'elle-même ; elle part dès que
  la clé est enregistrée (la même aussi), à un succès du bouton « Tester la connexion », ou à un nouveau
  clic. Ce refus ne concerne que ce foyer : l'extinction et les commandes d'un autre foyer ne sont
  jamais retenues par lui. Des 403 quand le temps manque, ou avec une clé déjà acceptée par ce foyer, ne
  sont jamais un refus : elle est réessayée ;
- la clé saisie est connue pour appartenir à un autre foyer (voir plus haut) : rien envoyé ; elle part
  dès qu'est enregistrée une clé dont on ne sait pas qu'elle appartient à un autre foyer ;
- un autre foyer (autre numéro de série) a été lu à l'adresse : rien envoyé, elle attend le sien ;
- après un redémarrage, elle attend la lecture de la configuration (la clé est un secret, jamais dans
  /data) ;
- le module ne répond pas : essayée toutes les 250 ms pendant 3 s, puis toutes les 15 s (elle part dans
  les 15 s qui suivent son retour) ; un module qui ne répond que 403 : toutes les 15 s quatre fois, puis
  espacé jusqu'à 1 h ;
- l'intégration s'arrête (Gladys lui a demandé de s'arrêter) : rien envoyé ; elle est gardée dans /data
  et part au démarrage suivant.

Une extinction est confirmée seulement par une lecture qui montre la flamme éteinte et le thermostat
arrêté. Sinon elle est relue toutes les 15 s et renvoyée tant que la flamme est allumée, 3 fois au plus ;
ensuite elle est retenue (dit dans le statut) sans nouvel envoi jusqu'à un nouveau clic. Elle est
levée par une lecture de son foyer le montrant éteint (deux lectures de suite si elle n'est jamais
partie), ou par un allumage de ce foyer cliqué ensuite depuis Gladys avec l'option ; jamais par le
temps, ni par l'extinction ou l'allumage d'un autre foyer (sauf au-delà de 4 foyers, comme dit plus
haut).

## Allumer, flamme, ventilateur, consigne

Désactivés par défaut. Avec l'option, chaque commande lit d'abord le foyer (lecture fraîche, jamais
l'état en mémoire) et vérifie de nouveau l'option juste avant chaque envoi. **Allumer** envoie la
flamme puis, aussitôt, une **minuterie** (60 min par défaut, 10 à 180) : le foyer s'éteint de lui-même
à son terme. Si la minuterie ne peut pas être posée, Gladys éteint le foyer aussitôt (la réponse dit si
l'extinction est partie). Ensuite, les lectures surveillent la séance, sans limite de durée et même
après un redémarrage (elle est gardée dans /data) : la minuterie lue (pas plus longue que la séance)
ou le foyer lu éteint la terminent ; un foyer lu éteint puis rallumé à la main n'est jamais éteint par
Gladys. La flamme lue sans cette minuterie 10 s après l'envoi : la minuterie est envoyée une seconde
fois, puis, toujours absente, Gladys éteint le foyer.

La **consigne** met le foyer en mode thermostat, qui n'a pas d'arrêt de sécurité de 9 h (réponse de
Hearth & Home dans intellifire4py, ticket 312) : Gladys envoie donc d'abord la minuterie de la séance,
puis la consigne, et surveille la séance comme un allumage ; à la fin de la séance (plus 2 min), si la
flamme ou le thermostat sont encore lus allumés, Gladys éteint le foyer. Si la consigne relue n'est
pas celle envoyée, Gladys remet aussitôt la consigne à 0 (thermostat arrêté). Une minuterie déjà en
cours et pas plus longue que la séance est gardée (jamais allongée) : la consigne part seule et la
séance finit avec cette minuterie ; une minuterie plus longue, ou aucune, est remplacée par celle de la
séance. À vérifier sur un vrai foyer : la fin de la minuterie
arrête-t-elle le mode thermostat.

Une commande est refusée, sans rien envoyer, quand :

- l'option est décochée, ou la configuration pas encore lue ;
- l'intégration s'arrête (Gladys lui a demandé de s'arrêter) ;
- la clé ou l'identifiant manquent, ou ce foyer les a refusés (sur preuve, voir plus haut ; levé par
  un enregistrement de la clé ou un succès de « Tester la connexion »), ou la clé saisie est connue
  pour appartenir à un autre foyer (voir plus haut) ;
- une autre commande est en cours, une extinction est en cours d'envoi, ou (sauf pour Allumer) une
  extinction de ce foyer est gardée ;
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

L'écran de configuration dit l'état du foyer, chaque extinction gardée ou retenue (nommée par la fin
du numéro de série de son foyer, 4 caractères, quand il y en a plusieurs, ou quand ce n'est pas le
foyer lu), une clé refusée ou absente, un module injoignable (prochain essai), une pause demandée par le
module.
