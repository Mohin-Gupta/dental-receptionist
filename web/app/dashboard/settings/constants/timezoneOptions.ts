export const TIMEZONE_OPTIONS: {
  group: string;
  zones: {
    value: string;
    label: string;
  }[];
}[] = [
  {
    group: 'Asia',
    zones: [
      {
        value: 'Asia/Kolkata',
        label:
          'India — Kolkata (IST, UTC+5:30)',
      },
      {
        value: 'Asia/Dubai',
        label:
          'UAE — Dubai (UTC+4:00)',
      },
      {
        value: 'Asia/Karachi',
        label:
          'Pakistan — Karachi (UTC+5:00)',
      },
      {
        value: 'Asia/Dhaka',
        label:
          'Bangladesh — Dhaka (UTC+6:00)',
      },
      {
        value: 'Asia/Singapore',
        label:
          'Singapore (UTC+8:00)',
      },
      {
        value: 'Asia/Hong_Kong',
        label:
          'Hong Kong (UTC+8:00)',
      },
      {
        value: 'Asia/Tokyo',
        label:
          'Japan — Tokyo (UTC+9:00)',
      },
      {
        value: 'Asia/Shanghai',
        label:
          'China — Shanghai (UTC+8:00)',
      },
      {
        value: 'Asia/Riyadh',
        label:
          'Saudi Arabia — Riyadh (UTC+3:00)',
      },
    ],
  },

  {
    group: 'Europe',
    zones: [
      {
        value: 'Europe/London',
        label:
          'United Kingdom — London (GMT/BST)',
      },
      {
        value: 'Europe/Dublin',
        label:
          'Ireland — Dublin (GMT/IST)',
      },
      {
        value: 'Europe/Paris',
        label:
          'France — Paris (CET/CEST)',
      },
      {
        value: 'Europe/Berlin',
        label:
          'Germany — Berlin (CET/CEST)',
      },
      {
        value: 'Europe/Madrid',
        label:
          'Spain — Madrid (CET/CEST)',
      },
      {
        value: 'Europe/Rome',
        label:
          'Italy — Rome (CET/CEST)',
      },
      {
        value: 'Europe/Amsterdam',
        label:
          'Netherlands — Amsterdam (CET/CEST)',
      },
      {
        value: 'Europe/Zurich',
        label:
          'Switzerland — Zurich (CET/CEST)',
      },
      {
        value: 'Europe/Moscow',
        label:
          'Russia — Moscow (UTC+3:00)',
      },
    ],
  },

  {
    group: 'North America',
    zones: [
      {
        value:
          'America/New_York',
        label:
          'US — Eastern (New York)',
      },
      {
        value:
          'America/Chicago',
        label:
          'US — Central (Chicago)',
      },
      {
        value:
          'America/Denver',
        label:
          'US — Mountain (Denver)',
      },
      {
        value:
          'America/Los_Angeles',
        label:
          'US — Pacific (Los Angeles)',
      },
      {
        value:
          'America/Anchorage',
        label:
          'US — Alaska (Anchorage)',
      },
      {
        value:
          'America/Toronto',
        label:
          'Canada — Toronto (Eastern)',
      },
      {
        value:
          'America/Vancouver',
        label:
          'Canada — Vancouver (Pacific)',
      },
      {
        value:
          'America/Mexico_City',
        label:
          'Mexico — Mexico City',
      },
    ],
  },

  {
    group: 'Oceania',
    zones: [
      {
        value:
          'Australia/Sydney',
        label:
          'Australia — Sydney (AEST/AEDT)',
      },
      {
        value:
          'Australia/Melbourne',
        label:
          'Australia — Melbourne (AEST/AEDT)',
      },
      {
        value:
          'Australia/Perth',
        label:
          'Australia — Perth (AWST)',
      },
      {
        value:
          'Pacific/Auckland',
        label:
          'New Zealand — Auckland (NZST/NZDT)',
      },
    ],
  },

  {
    group: 'Africa',
    zones: [
      {
        value:
          'Africa/Lagos',
        label:
          'Nigeria — Lagos (WAT, UTC+1:00)',
      },
      {
        value:
          'Africa/Johannesburg',
        label:
          'South Africa — Johannesburg (UTC+2:00)',
      },
      {
        value:
          'Africa/Cairo',
        label:
          'Egypt — Cairo (UTC+2:00)',
      },
      {
        value:
          'Africa/Nairobi',
        label:
          'Kenya — Nairobi (UTC+3:00)',
      },
    ],
  },

  {
    group: 'South America',
    zones: [
      {
        value:
          'America/Sao_Paulo',
        label:
          'Brazil — São Paulo',
      },
      {
        value:
          'America/Buenos_Aires',
        label:
          'Argentina — Buenos Aires',
      },
      {
        value:
          'America/Bogota',
        label:
          'Colombia — Bogotá',
      },
    ],
  },
];