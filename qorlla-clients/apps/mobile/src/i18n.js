// Text of the Welcome screen in the languages the web app ships (en, es, fr, pt-PT). English is the key. A missing translation falls back to English, never to an empty label.
// Only text of the native Welcome screen lives here; the web pages (sign-in, guest, help, meeting) are translated by the web app, which the app tells which language was chosen.
export const CATALOG = Object.freeze({
  es: {
    'Language': 'Idioma', 'Meet · Connect · Collaborate': 'Reúnete · Conecta · Colabora',
    'A secure workspace for video meetings, team collaboration and communication anywhere in the world.': 'Un espacio de trabajo seguro para videorreuniones, colaboración en equipo y comunicación en cualquier parte del mundo.',
    'Video Meetings': 'Videorreuniones', 'Host and join collaborative sessions with high-quality video and audio.': 'Organiza y únete a sesiones colaborativas con vídeo y audio de alta calidad.',
    'Team Collaboration': 'Colaboración en equipo', 'Work together with your team, share ideas and get things done.': 'Trabaja con tu equipo, comparte ideas y haz que las cosas sucedan.',
    'Communication': 'Comunicación', 'Stay connected with chats, communities and secure messaging.': 'Mantente conectado con chats, comunidades y mensajería segura.',
    'Security & Privacy': 'Seguridad y privacidad', 'Your data, meetings and conversations are protected and under your control.': 'Tus datos, reuniones y conversaciones están protegidos y bajo tu control.',
    'Join a Meeting': 'Unirse a una reunión', 'Enter the 11-digit meeting ID to join a session.': 'Introduce el ID de reunión de 11 dígitos para unirte a una sesión.', '11-digit meeting ID': 'ID de reunión de 11 dígitos',
    'Join Meeting': 'Unirse a la reunión', 'Joining…': 'Uniéndose…', 'OR': 'O', 'Sign In': 'Iniciar sesión', 'Use your Qorlla account': 'Usa tu cuenta de Qorlla', 'Continue as Guest': 'Continuar como invitado', 'Join without an account': 'Únete sin cuenta',
    'Help & Support': 'Ayuda y soporte', 'Get help, tutorials and FAQs': 'Ayuda, tutoriales y preguntas frecuentes', 'Explore Qorlla': 'Explorar Qorlla', 'Learn more about features and use cases': 'Conoce las funciones y casos de uso', 'Settings': 'Ajustes', 'Audio, video and app preferences': 'Preferencias de audio, vídeo y de la app',
    "Meetings use Qorlla's own meeting service. Restricted services remain unavailable in this build.": 'Las reuniones usan el servicio de reuniones propio de Qorlla. Los servicios restringidos siguen sin estar disponibles en esta versión.',
    'A meeting ID contains digits only. Remove the letters or symbols.': 'Un ID de reunión solo contiene dígitos. Quita las letras o los símbolos.',
  },
  fr: {
    'Language': 'Langue', 'Meet · Connect · Collaborate': 'Réunir · Connecter · Collaborer',
    'A secure workspace for video meetings, team collaboration and communication anywhere in the world.': 'Un espace de travail sécurisé pour les réunions vidéo, la collaboration d’équipe et la communication partout dans le monde.',
    'Video Meetings': 'Réunions vidéo', 'Host and join collaborative sessions with high-quality video and audio.': 'Organisez et rejoignez des sessions collaboratives avec une vidéo et un son de haute qualité.',
    'Team Collaboration': 'Collaboration d’équipe', 'Work together with your team, share ideas and get things done.': 'Travaillez avec votre équipe, partagez vos idées et avancez ensemble.',
    'Communication': 'Communication', 'Stay connected with chats, communities and secure messaging.': 'Restez connecté grâce aux discussions, aux communautés et à la messagerie sécurisée.',
    'Security & Privacy': 'Sécurité et confidentialité', 'Your data, meetings and conversations are protected and under your control.': 'Vos données, réunions et conversations sont protégées et sous votre contrôle.',
    'Join a Meeting': 'Rejoindre une réunion', 'Enter the 11-digit meeting ID to join a session.': 'Saisissez l’identifiant de réunion à 11 chiffres pour rejoindre une session.', '11-digit meeting ID': 'Identifiant de réunion à 11 chiffres',
    'Join Meeting': 'Rejoindre la réunion', 'Joining…': 'Connexion…', 'OR': 'OU', 'Sign In': 'Se connecter', 'Use your Qorlla account': 'Utilisez votre compte Qorlla', 'Continue as Guest': 'Continuer en invité', 'Join without an account': 'Rejoindre sans compte',
    'Help & Support': 'Aide et assistance', 'Get help, tutorials and FAQs': 'Aide, tutoriels et FAQ', 'Explore Qorlla': 'Découvrir Qorlla', 'Learn more about features and use cases': 'Fonctionnalités et cas d’usage', 'Settings': 'Paramètres', 'Audio, video and app preferences': 'Préférences audio, vidéo et application',
    "Meetings use Qorlla's own meeting service. Restricted services remain unavailable in this build.": 'Les réunions utilisent le service de réunion propre à Qorlla. Les services restreints restent indisponibles dans cette version.',
    'A meeting ID contains digits only. Remove the letters or symbols.': 'Un identifiant de réunion ne contient que des chiffres. Retirez les lettres ou les symboles.',
  },
  'pt-PT': {
    'Language': 'Idioma', 'Meet · Connect · Collaborate': 'Reúna · Ligue · Colabore',
    'A secure workspace for video meetings, team collaboration and communication anywhere in the world.': 'Um espaço de trabalho seguro para videorreuniões, colaboração em equipa e comunicação em qualquer parte do mundo.',
    'Video Meetings': 'Videorreuniões', 'Host and join collaborative sessions with high-quality video and audio.': 'Organize e participe em sessões colaborativas com vídeo e áudio de alta qualidade.',
    'Team Collaboration': 'Colaboração em equipa', 'Work together with your team, share ideas and get things done.': 'Trabalhe com a sua equipa, partilhe ideias e faça acontecer.',
    'Communication': 'Comunicação', 'Stay connected with chats, communities and secure messaging.': 'Mantenha-se ligado com conversas, comunidades e mensagens seguras.',
    'Security & Privacy': 'Segurança e privacidade', 'Your data, meetings and conversations are protected and under your control.': 'Os seus dados, reuniões e conversas estão protegidos e sob o seu controlo.',
    'Join a Meeting': 'Entrar numa reunião', 'Enter the 11-digit meeting ID to join a session.': 'Introduza o ID de reunião de 11 dígitos para entrar numa sessão.', '11-digit meeting ID': 'ID de reunião de 11 dígitos',
    'Join Meeting': 'Entrar na reunião', 'Joining…': 'A entrar…', 'OR': 'OU', 'Sign In': 'Iniciar sessão', 'Use your Qorlla account': 'Use a sua conta Qorlla', 'Continue as Guest': 'Continuar como convidado', 'Join without an account': 'Entre sem conta',
    'Help & Support': 'Ajuda e suporte', 'Get help, tutorials and FAQs': 'Ajuda, tutoriais e perguntas frequentes', 'Explore Qorlla': 'Explorar o Qorlla', 'Learn more about features and use cases': 'Saiba mais sobre funcionalidades e casos de utilização', 'Settings': 'Definições', 'Audio, video and app preferences': 'Preferências de áudio, vídeo e da aplicação',
    "Meetings use Qorlla's own meeting service. Restricted services remain unavailable in this build.": 'As reuniões utilizam o serviço de reuniões próprio do Qorlla. Os serviços restritos continuam indisponíveis nesta versão.',
    'A meeting ID contains digits only. Remove the letters or symbols.': 'Um ID de reunião contém apenas dígitos. Remova as letras ou os símbolos.',
  },
});

/** Text for a language; anything not translated (or an unknown language) is shown in English. */
export const translate = (language, text) => (CATALOG[language] && CATALOG[language][text]) || text;
/** "3 of 11 digits", "That is 12 digits…": the dynamic hints are built per language. */
export function digitsHint(language, n, total = 11) {
  const w = { es: 'de', fr: 'sur', 'pt-PT': 'de' }[language] || 'of', unit = { es: 'dígitos', fr: 'chiffres', 'pt-PT': 'dígitos' }[language] || 'digits';
  return n + ' ' + w + ' ' + total + ' ' + unit;
}
export function tooLongHint(language, n) {
  return { es: 'Son ' + n + ' dígitos. Un ID tiene exactamente 11; no se ha cortado nada.', fr: 'Cela fait ' + n + ' chiffres. Un identifiant en compte exactement 11 ; rien n’a été coupé.', 'pt-PT': 'São ' + n + ' dígitos. Um ID tem exatamente 11; nada foi cortado.' }[language] || 'That is ' + n + ' digits. A meeting ID has exactly 11; nothing was cut off.';
}
