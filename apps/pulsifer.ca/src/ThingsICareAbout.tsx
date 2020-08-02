import React from 'react';
import {
  ResourceList,
  ResourceItem,
  TextStyle,
} from '@shopify/polaris';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faShopify,
  faGithub,
  faTwitter,
  faInstagram,
  faSteam,
  faDiscord,
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
    name: 'Shopify',
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
      media={<FontAwesomeIcon icon={icon} size="3x" />}
      accessibilityLabel={`View details for ${name}`}
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
