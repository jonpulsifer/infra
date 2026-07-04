---
title: "Securing Shopify's PaaS on GKE"
description: KubeCon NA 2017 talk about the current state of Kubernetes security controls on GKE and how to integrate security controls into developer pipelines
date: "2017-11-15"
author: "jonpulsifer"
draft: false
tags:
- Cloud
- Containers
- Google Cloud Platform
- KubeCon
- Kubernetes
- Multi-tenancy
- SecTor
---

This is a talk I [gave at SecTor](https://sector.ca/sessions/securing-shopifys-paas-on-gke/), as well as at KubeCon the following month!

{{< youtube id="ZrweAu9T24A" title="Securing Shopify's PaaS on GKE" >}}

Shopify has leveraged Kubernetes through Google Container Engine (GKE) to build its new cloud platform. This PaaS is currently serving the majority of the company's internal tools as well as business-critical production workloads. Moving to Kubernetes and a public cloud is no easy task, especially for a security team. 

Unfortunately for us, a hosted solution does not offer all the features we've come to love in Kubernetes including NetworkPolicies, PodSecurityPolicies, and admission controllers among others. Given this, the security team has created a number of Kubernetes controllers and other cloud platform solutions to maintain an effective security posture on our new platform.

In this talk we'll introduce our cloud platform, explore the tools we've created to bridge the security gaps, detail the struggles we've encountered using Google Cloud Platform and GKE, and discuss our growing pains with Kubernetes multi-tenancy. Attendees will gain an understanding of the current state of Kubernetes security controls on GKE, a familiarity with some of the products available on Google Cloud Platform, and insight on how to integrate security controls into their development pipelines.
