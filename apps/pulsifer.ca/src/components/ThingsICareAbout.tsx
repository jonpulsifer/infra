import React from 'react';
import {
  ResourceList,
  ResourceItem,
  TextStyle,
} from '@shopify/polaris';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faDiscord,
  faGithub,
  faInstagram,
  faLinkedin,
  faShopify,
  faSteam,
  faTwitter,
  IconDefinition,
} from "@fortawesome/free-brands-svg-icons";

interface ThingICareAbout {
  url: string,
  icon: IconDefinition,
  name: string,
  description: string,
};

const items : ThingICareAbout[] = [
  {
    url: 'https://shopify.ca',
    icon: faShopify,
    name: 'Security Incident Response',
    description: 'This is where I work',
  },
  {
    url: 'https://github.com/jonpulsifer',
    icon: faGithub,
    name: '@jonpulsifer',
    description: 'This is where I code',
  },
  {
    url: 'https://twitter.com/jonpulsifer',
    icon: faTwitter,
    name: '@jonpulsifer',
    description: 'This is where I chirp',
  },
  {
    url: 'https://www.linkedin.com/in/jonpulsifer/',
    icon: faLinkedin,
    name: '@jonpulsifer',
    description: 'This is where I network',
  },
  {
    url: 'https://steamcommunity.com/id/jawn',
    icon: faSteam,
    name: '𝖏𝖆𝖜𝖓 -𝖊-',
    description: 'This is where I game',
  },
  {
    url: 'https://kthx.dev/discord',
    icon: faDiscord,
    name: 'Evilcorp',
    description: 'This is where I talk',
  },
  {
    url: 'https://instagr.am/jonpulsifer.ca',
    icon: faInstagram,
    name: '@jonpulsifer.ca',
    description: 'This is where I selfie',
  },
]

const renderItems = (item: ThingICareAbout, index: string) => {
  const {url, icon, name, description} = item;
  return (
    <ResourceItem
      id={index}
      url={url}
      media={<FontAwesomeIcon fixedWidth icon={icon} size="3x" />}
      accessibilityLabel={`Visit me at ${url}`}
      name={name}
    >
      <h3>
        <TextStyle variation="strong">{name}</TextStyle>
      </h3>
      <div>{description}</div>
    </ResourceItem>
  ); 
};

export default function ThingsICareAbout() {
  return (
    <ResourceList
      items={items}
      renderItem={renderItems}
    />
  );
}
