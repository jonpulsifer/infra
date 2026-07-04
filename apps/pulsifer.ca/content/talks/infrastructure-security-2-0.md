---
title: "Infrastructure Security 2.0"
description: "Talk about what containers are, are not, and how to build, deploy, and secure them on Kubernetes"
date: "2017-11-09"
author: "jonpulsifer"
draft: false
tags:
- Cloud
- Containers
- Kubernetes
- Software Supply Chain
- Multi-tenancy
---

{{< youtube id="FUkThjw1X5Y" title="Infrastructure Security 2.0" >}}

Shopify has leveraged Kubernetes through Google Container Engine (GKE) to build its new cloud platform. This PaaS is currently serving the majority of the company's internal tools as well as business-critical production workloads. Moving to Kubernetes and a public cloud is no easy task, especially for a security team.

Given industry's limited experience with cloud computing and cloud native technologies, this talk hopes to demystify some of these core cloud concepts. We'll talk about containers: what they are, how to build them, how to secure them, and how to integrate security tooling into build and deployment pipelines.

Building a secure container is one thing, but how do we deploy containers to production? What does this mean? We'll introduce Kubernetes, an open-source system for automating deployment, scaling, and management of containerized applications. With Kubernetes we also have a number of security controls that we can implement to further restrict the operation of containers. We'll explore some of these primitives as they'll fit nicely with the context on container security.

Lastly, running on a public cloud comes with its own unique challenges. We'll explore some of the pitfalls we've encountered deploying infrastructure to a public cloud.
